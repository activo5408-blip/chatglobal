// Relay: hace que el servidor se comporte como una LAN más.
// Envuelve window.__TAURI__.core.invoke ANTES de que app.js lo capture, de modo que:
//   · list_peers   -> contactos de la LAN + usuarios del servidor, SIN duplicados (un contacto = un id)
//   · poll_messages-> mensajes de la LAN + mensajes recibidos por el servidor
//   · send_*       -> por la LAN si el contacto está en ella; por el servidor si solo está allí (o si la LAN falla)
// El audio/vídeo de las llamadas lo gestiona callserver.js (salas WebRTC); en la misma LAN se sigue usando P2P directo.
// Cargar después de android-shim.js/mic.js y ANTES de app.js.
(function () {
  "use strict";
  const T = window.__TAURI__;
  if (!T || !T.core || T.core.__relayPatched) return;
  const raw = T.core.invoke;
  const IS_ANDROID = !!window.AndroidBridge;

  const MAX_FILE = 10 * 1024 * 1024;   // tope por el servidor (la LAN no tiene límite)
  const CHUNK_B64 = 32768;             // múltiplo de 4
  const FRAG_SIZE = 32000, FRAG_THRESHOLD = 40000, FRAG_MAX = 40;
  const RX_TTL = 120000;

  const SRV = () => window.ChatlanSrv || null;
  const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : v == null ? "" : String(v).slice(0, n));
  const tsNow = () => { const d = new Date(); let h = d.getHours(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return String(h).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + " " + ap; };

  let selfId = "";
  async function getSelfId() { if (!selfId) selfId = await raw("get_self_id"); return selfId; }
  const getName = () => raw("get_self_name").catch(() => "Anonimo");

  // ---------------------------------------------------------------- estado LAN / servidor
  let lanOnline = new Set();
  const queue = [];                    // mensajes recibidos por el servidor, pendientes de poll_messages
  const srvPeer = (id) => { const S = SRV(); return S && S.up() ? S.peers().find((p) => p.id === id) || null : null; };
  const viaServer = (id) => !!srvPeer(id);
  const preferRelay = (id) => viaServer(id) && !lanOnline.has(id);

  window.ChatlanRelay = {
    lanOnline: (id) => lanOnline.has(id),
    viaServer, maxFile: MAX_FILE,
  };

  // ---------------------------------------------------------------- envío por el servidor
  async function relaySend(peerId, wire, ack) {
    const S = SRV();
    if (!S || !S.up()) throw new Error("Sin conexión con el servidor");
    const text = JSON.stringify(wire);
    if (text.length <= FRAG_THRESHOLD) return S.send(peerId, text, ack !== false);
    // mensajes grandes (avatar): se trocean y se reensamblan en el receptor
    const n = Math.ceil(text.length / FRAG_SIZE);
    if (n > FRAG_MAX) throw new Error("Mensaje demasiado grande para el servidor");
    const fid = uid().slice(0, 16);
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      await S.send(peerId, JSON.stringify({ kind: "Frag", fid, i, n, d: text.slice(i * FRAG_SIZE, (i + 1) * FRAG_SIZE) }), last || i % 8 === 7);
      if (!last) await sleep(4);
    }
  }

  // Envía por el canal adecuado. nativeCall: función que envía por la LAN. wire: mensaje equivalente para el servidor.
  async function route(peerId, wire, nativeCall, ack) {
    if (preferRelay(peerId)) return relaySend(peerId, wire, ack);
    try { return await nativeCall(); }
    catch (e) { if (viaServer(peerId)) return relaySend(peerId, wire, ack); throw e; }
  }

  async function wireBase(kind) { return { kind, id: await getSelfId(), from: await getName() }; }

  // ---- archivos
  async function sendFileB64(peerId, filename, b64, size) {
    if (size > MAX_FILE) throw new Error("Por el servidor el límite por archivo es " + Math.round(MAX_FILE / 1048576) + " MB");
    const tid = uid();
    const total = Math.max(1, Math.ceil(b64.length / CHUNK_B64));
    await relaySend(peerId, { kind: "FileStart", id: tid, sender_id: await getSelfId(), from: await getName(), filename: str(filename, 200), size, chunks: total }, true);
    for (let i = 0; i < total; i++) {
      const last = i === total - 1;
      await SRV().send(peerId, JSON.stringify({ kind: "FileChunk", id: tid, i, d: b64.slice(i * CHUNK_B64, (i + 1) * CHUNK_B64) }), last || i % 8 === 7);
      await SRV().drain();
      await sleep(4);                // ~250 mensajes/s como máximo: por debajo del límite del servidor
    }
    await relaySend(peerId, { kind: "FileEnd", id: tid, chunks: total }, true);
  }
  const base64OfDataUrl = (u) => String(u).slice(String(u).indexOf(",") + 1);
  function bytesToB64(arr) {
    let bin = ""; const step = 0x8000;
    for (let i = 0; i < arr.length; i += step) bin += String.fromCharCode.apply(null, arr.slice(i, i + step));
    return btoa(bin);
  }
  async function sendPathViaServer(peerId, path) {
    const size = Number(await raw("get_file_size", { path }));
    if (size > MAX_FILE) throw new Error("Por el servidor el límite por archivo es " + Math.round(MAX_FILE / 1048576) + " MB");
    const url = await raw("read_file_as_base64", { path });
    await sendFileB64(peerId, String(path).split(/[\\/]/).pop(), base64OfDataUrl(url), size);
  }

  // ---------------------------------------------------------------- recepción desde el servidor
  const frags = new Map();    // fid -> { from, n, parts, t }
  const fileRx = new Map();   // from:id -> { id, from, name, filename, size, n, parts, got, t }

  function notify(msg) { try { raw("relay_notify", { msg }).catch(() => {}); } catch (e) {} }

  function onRelay(from, data) {
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    const sp = srvPeer(from);
    const name = sp ? sp.name : str(m.from, 40) || "Contacto";   // el nombre lo manda el servidor, no el remitente
    handleWire(from, name, m);
  }

  function handleWire(from, name, m) {
    const k = m.kind;
    if (k === "Frag") {
      if (typeof m.fid !== "string" || !(m.n >= 1 && m.n <= FRAG_MAX) || !(m.i >= 0 && m.i < m.n)) return;
      const key = from + ":" + m.fid;
      let f = frags.get(key);
      if (!f) {
        if ([...frags.values()].filter((x) => x.from === from).length >= 4) return;
        f = { from, n: m.n, parts: [], got: 0, t: Date.now() }; frags.set(key, f);
      }
      if (f.parts[m.i] === undefined) { f.parts[m.i] = str(m.d, FRAG_SIZE + 10); f.got++; }
      if (f.got === f.n) {
        frags.delete(key);
        let inner; try { inner = JSON.parse(f.parts.join("")); } catch (e) { return; }
        if (inner && inner.kind !== "Frag") handleWire(from, name, inner);
      }
      return;
    }
    if (k === "Text") {
      const msg = { kind: "Text", id: from, msg_id: str(m.msg_id, 64) || uid(), from: esc(name), body: esc(str(m.body, 20000)), ts: str(m.ts, 16) || tsNow(),
        reply_to: m.reply_to == null ? null : str(m.reply_to, 64), reply_body: m.reply_body == null ? null : esc(str(m.reply_body, 2000)), reply_from: m.reply_from == null ? null : esc(str(m.reply_from, 40)) };
      queue.push(msg);
      notify({ kind: "Text", id: from, msg_id: msg.msg_id, from: IS_ANDROID ? name : msg.from, body: IS_ANDROID ? str(m.body, 500) : msg.body, ts: msg.ts });
    } else if (k === "Typing" || k === "Read") {
      queue.push({ kind: k, id: from, from: esc(name) });
    } else if (k === "DeleteMessage") {
      queue.push({ kind: k, id: from, msg_id: str(m.msg_id, 64) });
    } else if (k === "Reaction") {
      queue.push({ kind: k, id: from, msg_id: str(m.msg_id, 64), emoji: esc(str(m.emoji, 16)), action: str(m.action, 10) });
    } else if (k === "Call") {
      if (!["invite", "accept", "reject", "end", "sdp", "ice"].includes(m.op)) return;
      queue.push({ kind: "Call", id: from, from: esc(name), call_id: str(m.call_id, 64), op: m.op, video: !!m.video, data: str(m.data, 32000) });
    } else if (k === "AvatarUpdate") {
      const a = str(m.avatar_b64, 900000);
      if (!/^data:image\/(png|jpeg|webp|gif|bmp);base64,[A-Za-z0-9+/=]+$/.test(a)) return;
      queue.push({ kind: "AvatarUpdate", id: from, name: esc(name), avatar_b64: a });
    } else if (k === "FileStart") {
      const size = Number(m.size) || 0, n = Number(m.chunks) || 0;
      if (size < 0 || size > MAX_FILE || n < 1 || n > Math.ceil(MAX_FILE / (CHUNK_B64 * 0.75)) + 2 || typeof m.id !== "string") return;
      if ([...fileRx.values()].filter((x) => x.from === from).length >= 3) return;
      const key = from + ":" + m.id.slice(0, 64);
      const filename = str(m.filename, 200) || "archivo";
      fileRx.set(key, { id: key, from, name, filename, size, n, parts: [], got: 0, t: Date.now() });
      queue.push({ kind: "FileStart", id: key, sender_id: from, from: esc(name), filename: esc(filename), size });
      notify({ kind: "FileStart", id: key, sender_id: from, from: IS_ANDROID ? name : esc(name), filename: IS_ANDROID ? filename : esc(filename), size });
    } else if (k === "FileChunk") {
      const rx = fileRx.get(from + ":" + str(m.id, 64));
      if (!rx || !(m.i >= 0 && m.i < rx.n) || rx.parts[m.i] !== undefined) return;
      rx.parts[m.i] = str(m.d, CHUNK_B64 + 8); rx.got++; rx.t = Date.now();
    } else if (k === "FileEnd") {
      const key = from + ":" + str(m.id, 64);
      const rx = fileRx.get(key); if (!rx) return;
      fileRx.delete(key);
      if (rx.got !== rx.n) { console.error("[relay] archivo incompleto", rx.got, "/", rx.n); return; }
      finishFile(rx);
    }
  }

  async function finishFile(rx) {
    try {
      const bin = atob(rx.parts.join(""));
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const ext = (rx.filename.split(".").pop() || "bin").replace(/[^A-Za-z0-9]/g, "").slice(0, 10) || "bin";
      const path = await raw("save_temp_file", { data: Array.from(u8), ext });
      queue.push({ kind: "FileReceived", id: rx.id, sender_id: rx.from, from: esc(rx.name), filename: esc(rx.filename), size: rx.size, temp_path: path });
    } catch (e) { console.error("[relay] no se pudo guardar el archivo", e); }
  }

  setInterval(() => {   // limpieza de transferencias abandonadas
    const now = Date.now();
    for (const [k, v] of frags) if (now - v.t > 60000) frags.delete(k);
    for (const [k, v] of fileRx) if (now - v.t > RX_TTL) fileRx.delete(k);
  }, 15000);

  // ---------------------------------------------------------------- avatar hacia usuarios del servidor
  let knownSrv = new Set();
  async function sendMyAvatarTo(ids) {
    try {
      const a = await raw("load_avatar");
      if (!a) return;
      const base = await wireBase("AvatarUpdate");
      for (const id of ids) { try { await relaySend(id, { kind: "AvatarUpdate", id: base.id, name: base.from, avatar_b64: a }, false); } catch (e) {} }
    } catch (e) {}
  }
  function onSrvPeers(list) {
    const ids = new Set((list || []).map((p) => p.id));
    const fresh = [...ids].filter((id) => !knownSrv.has(id));
    knownSrv = ids;
    if (fresh.length) setTimeout(() => sendMyAvatarTo(fresh.filter((id) => !lanOnline.has(id))), 800);
  }

  function hook() {
    const S = SRV();
    if (!S) return false;
    S.onRelay = onRelay; S.onPeers = onSrvPeers;
    return true;
  }
  if (!hook()) { const t = setInterval(() => { if (hook()) clearInterval(t); }, 200); }

  // ---------------------------------------------------------------- invoke parcheado
  async function patched(cmd, args) {
    args = args || {};
    switch (cmd) {
      case "list_peers": {
        const lan = await raw("list_peers", args);
        lanOnline = new Set((lan || []).filter((p) => p.online).map((p) => p.id));
        const S = SRV();
        if (!S || !S.up()) return lan;
        const out = (lan || []).map((p) => Object.assign({}, p));
        const byId = new Map(out.map((p) => [p.id, p]));
        for (const sp of S.peers()) {
          const e = byId.get(sp.id);
          if (e) { e.via = e.online ? "both" : "server"; e.online = true; continue; }
          // fantasma: entrada vieja de la LAN con el mismo nombre y desconectada -> se sustituye por la del servidor
          for (let i = out.length - 1; i >= 0; i--) if (!out[i].online && out[i].name === esc(sp.name) && !S.peers().some((x) => x.id === out[i].id)) { byId.delete(out[i].id); out.splice(i, 1); }
          const np = { id: sp.id, name: esc(sp.name), addr: "", addrs: [], online: true, idle_secs: 0, via: "server" };
          out.push(np); byId.set(np.id, np);
        }
        return out;
      }
      case "poll_messages": {
        const r = await raw("poll_messages", args);
        if (!queue.length) return r;
        return (r || []).concat(queue.splice(0));
      }
      case "set_self_name": {
        const r = await raw(cmd, args);
        const S = SRV(); if (S) S.rename();
        return r;
      }
      case "send_text": {
        const msgId = uid(), ts = tsNow();
        const wire = Object.assign(await wireBase("Text"), { msg_id: msgId, body: args.body, ts, reply_to: args.replyTo || null, reply_body: args.replyBody || null, reply_from: args.replyFrom || null });
        if (preferRelay(args.peerId)) { await relaySend(args.peerId, wire, true); return msgId; }
        try { return await raw(cmd, args); }
        catch (e) { if (viaServer(args.peerId)) { await relaySend(args.peerId, wire, true); return msgId; } throw e; }
      }
      case "send_reply_from_notif": {
        if (!preferRelay(args.peerId)) {
          try { return await raw(cmd, args); } catch (e) { if (!viaServer(args.peerId)) throw e; }
        }
        const msgId = uid(), ts = tsNow();
        await relaySend(args.peerId, Object.assign(await wireBase("Text"), { msg_id: msgId, body: args.body, ts, reply_to: args.replyTo || null, reply_body: args.replyBody || null, reply_from: args.replyFrom || null }), true);
        try { T.event.emit("notif-reply-echo", { peerId: args.peerId, body: args.body, ts, msgId }); } catch (e) {}
        return null;
      }
      case "send_typing":
        return route(args.peerId, await wireBase("Typing"), () => raw(cmd, args), false);
      case "send_read_receipt":
        return route(args.peerId, await wireBase("Read"), () => raw(cmd, args), false);
      case "send_delete_message":
        return route(args.peerId, { kind: "DeleteMessage", id: await getSelfId(), msg_id: args.msgId }, () => raw(cmd, args), true);
      case "send_reaction":
        return route(args.peerId, { kind: "Reaction", id: await getSelfId(), msg_id: args.msgId, emoji: args.emoji, action: args.action }, () => raw(cmd, args), true);
      case "send_call":
        return route(args.peerId, Object.assign(await wireBase("Call"), { call_id: args.callId, op: args.op, video: !!args.video, data: args.data || "" }), () => raw(cmd, args), true);
      case "send_file_path": {
        if (preferRelay(args.peerId)) return sendPathViaServer(args.peerId, args.path);
        try { return await raw(cmd, args); } catch (e) { if (viaServer(args.peerId)) return sendPathViaServer(args.peerId, args.path); throw e; }
      }
      case "send_clipboard_image": {
        const viaSrv = async () => { const u8 = Uint8Array.from(args.data || []); await sendFileB64(args.peerId, uid() + ".png", bytesToB64(u8), u8.length); };
        if (preferRelay(args.peerId)) return viaSrv();
        try { return await raw(cmd, args); } catch (e) { if (viaServer(args.peerId)) return viaSrv(); throw e; }
      }
      case "broadcast_avatar": {
        const r = await raw(cmd, args);
        const S = SRV();
        if (S && S.up()) {
          const base = await wireBase("AvatarUpdate");
          for (const sp of S.peers()) if (!lanOnline.has(sp.id)) relaySend(sp.id, { kind: "AvatarUpdate", id: base.id, name: base.from, avatar_b64: args.avatarB64 }, false).catch(() => {});
        }
        return r;
      }
      default:
        return raw(cmd, args);
    }
  }
  patched.__relayPatched = true;
  try { T.core.invoke = patched; T.core.__relayPatched = true; }
  catch (e) { try { Object.defineProperty(T.core, "invoke", { value: patched, configurable: true }); } catch (e2) { console.error("[relay] no se pudo parchear invoke", e2); } }
})();
