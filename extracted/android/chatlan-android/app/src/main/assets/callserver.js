// Servidor de llamadas (opcional): llamadas, videollamadas y llamadas grupales a través de tu propio servidor.
// Sin servidor configurado, la app sigue funcionando 100 % P2P por la red local (call.js).
// Protocolo: WebSocket JSON contra chatlan-server (ver README del servidor). Medios: malla WebRTC.
(function () {
  "use strict";
  const T = window.__TAURI__;
  if (!T || !T.core) return;
  const invoke = T.core.invoke;
  const AB = window.AndroidBridge || null;
  const CC = (window.ChatlanCall = window.ChatlanCall || {});
  const LS_KEY = "chatlan.callserver";
  const RING_MS = 45000;
  const MAX_TILES = 12;

  // ------------------------------------------------------------ configuración
  function loadCfg() {
    try { const o = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); return { url: o.url || "", key: o.key || "", enabled: !!o.enabled }; }
    catch (e) { return { url: "", key: "", enabled: false }; }
  }
  function saveCfg() { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) {} }
  let cfg = loadCfg();

  function normUrl(raw) {
    let s = String(raw || "").trim();
    if (!s) throw new Error("URL vacía");
    if (/^https?:\/\//i.test(s)) s = s.replace(/^http/i, "ws");
    else if (!/^wss?:\/\//i.test(s)) s = "wss://" + s;
    const u = new URL(s);
    if (!u.pathname || u.pathname === "/") u.pathname = "/ws";
    return u.toString();
  }

  // ------------------------------------------------------------ conexión al servidor
  let ws = null, ready = false, selfId = "", backoff = 1000, reconnectTimer = null;
  let serverPeers = [];
  let statusText = "Desactivado", statusKind = "";
  let gen = 0, authFailed = false, curReport = false, connTimer = null, helloTimer = null;

  function setStatus(t, kind) {
    statusText = t; statusKind = kind || "";
    const el = document.getElementById("srvCfgStatus");
    if (el) { el.textContent = t; el.className = "srv-cfg-status " + statusKind; }
  }

  let toastTimer = null;
  function toast(text, kind, ms) {
    let el = document.getElementById("srvToast");
    if (!el) { el = document.createElement("div"); el.id = "srvToast"; document.body.appendChild(el); }
    el.textContent = text; el.className = "show " + (kind || "");
    clearTimeout(toastTimer);
    if (ms !== 0) toastTimer = setTimeout(() => { el.className = ""; }, ms || 4000);
  }

  const serverReady = () => !!(cfg.enabled && ready && ws);

  // ------------------------------------------------------------ API de retransmisión (chat, archivos, avatares...)
  // relay.js la usa para que el servidor funcione como una LAN: contactos, mensajes, archivos y llamadas.
  let relayOk = false;
  const pend = new Map();   // ref -> { res, rej, t }
  function failPending(text) { pend.forEach((p) => { clearTimeout(p.t); p.rej(new Error(text)); }); pend.clear(); }
  const NACK = { offline: "El contacto no está conectado al servidor", rate_limited: "Demasiado rápido, espera un momento", bad_request: "Mensaje demasiado grande" };
  const SRV = (window.ChatlanSrv = {
    up: () => !!(cfg.enabled && ready && ws && relayOk),
    peers: () => serverPeers,
    onRelay: null, onPeers: null,
    rename: () => { if (ready) selfName().then((n) => wsSend({ type: "rename", name: n })).catch(() => {}); },
    drain: () => new Promise((res) => { const t = () => { if (!ws || ws.bufferedAmount < 256 * 1024) res(); else setTimeout(t, 15); }; t(); }),
    send: (to, data, ack) => new Promise((res, rej) => {
      if (!SRV.up()) return rej(new Error("Sin conexión con el servidor"));
      const ref = uid().slice(0, 16);
      if (!ack) { wsSend({ type: "relay", to, data, ref }); return res(); }
      const t = setTimeout(() => { pend.delete(ref); rej(new Error("El servidor no confirmó la entrega")); }, 8000);
      pend.set(ref, { res, rej, t });
      wsSend({ type: "relay", to, data, ref, ack: true });
    }),
  });
  const wsSend = (o) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) {} };
  const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));

  async function selfName() { try { return await invoke("get_self_name"); } catch (e) { return "Anonimo"; } }

  function clearTimers() { clearTimeout(connTimer); clearTimeout(helloTimer); connTimer = helloTimer = null; }

  function closeWs() {
    clearTimeout(reconnectTimer); clearTimers();
    const sck = ws; ws = null; ready = false; serverPeers = []; relayOk = false; failPending("Sin conexión con el servidor");
    if (sck) { try { sck.onclose = null; sck.onmessage = null; sck.close(); } catch (e) {} }
  }

  // ¿responde el servidor por HTTP(S)? Sirve para distinguir "no llego" de "llego pero el WebSocket falla".
  async function probeHttp(wsUrl) {
    try {
      const u = new URL(wsUrl);
      u.protocol = u.protocol === "wss:" ? "https:" : "http:"; u.pathname = "/"; u.search = "";
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 6000);
      try { await fetch(u.toString(), { mode: "no-cors", cache: "no-store", signal: ac.signal }); return "reachable"; }
      finally { clearTimeout(t); }
    } catch (e) { return (e && e.name === "AbortError") ? "timeout" : "unreachable"; }
  }

  function fail(g, msg, fatal) {
    if (g !== gen) return;
    clearTimers();
    const sck = ws; ws = null; ready = false; relayOk = false; failPending("Sin conexión con el servidor");
    if (sck) { try { sck.onclose = null; sck.onmessage = null; sck.close(); } catch (e) {} }
    setStatus("Error: " + msg + (fatal || !cfg.enabled ? "" : " (reintentando…)"), "err");
    if (curReport) { toast("Servidor — Error: " + msg, "err", 8000); curReport = false; }
    if (!fatal && cfg.enabled) { reconnectTimer = setTimeout(() => connect({}), backoff); backoff = Math.min(backoff * 2, 30000); }
  }

  async function connect(opts) {
    opts = opts || {};
    closeWs();
    const g = ++gen;
    authFailed = false;
    if (opts.report) curReport = true;
    if (!cfg.url || !cfg.key) { fail(g, "falta la URL o la API key", true); return; }
    if (!cfg.enabled && !opts.test) { setStatus("Desactivado"); return; }
    let url;
    try { url = normUrl(cfg.url); } catch (e) { fail(g, "la URL no es válida (" + e.message + ")", true); return; }
    try { selfId = await invoke("get_self_id"); } catch (e) { fail(g, "no se pudo leer el ID local de la app", true); return; }
    if (g !== gen) return;
    setStatus("Conectando…", "busy");
    if (curReport) toast("Conectando al servidor…", "busy", 0);
    let sock;
    try { sock = new WebSocket(url); }
    catch (e) {
      const sec = e && (e.name === "SecurityError" || /insecure|mixed/i.test(String(e.message)));
      fail(g, sec ? "el sistema bloqueó la conexión ws:// (usa wss:// con certificado válido)" : "no se pudo abrir la conexión (" + ((e && e.name) || e) + ")", true);
      return;
    }
    ws = sock;
    connTimer = setTimeout(async () => {
      if (g !== gen || ready) return;
      const pr = await probeHttp(url);
      fail(g, pr === "unreachable" ? "no se puede alcanzar el servidor (DNS, certificado TLS no válido, firewall o sin internet)"
        : "tiempo de espera agotado al conectar con " + new URL(url).host, false);
    }, 10000);
    sock.onopen = async () => {
      if (g !== gen) return;
      clearTimeout(connTimer);
      sock.send(JSON.stringify({ type: "hello", key: cfg.key, id: selfId, name: await selfName() }));
      helloTimer = setTimeout(() => {
        fail(g, "el servidor aceptó la conexión pero no respondió como servidor de llamadas de ChatLAN (¿es otro servicio o una versión distinta?)", false);
      }, 8000);
    };
    sock.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMsg(m); };
    let down = false;
    // en navegadores "error" precede siempre a "close"; se unifican para no depender de ello
    sock.onerror = () => { if (!down && !ready) { down = true; handleDown(1006); } };
    sock.onclose = (ev) => { if (down) return; down = true; handleDown(ev.code); };
    const handleDown = async (code) => {
      if (g !== gen) return;
      clearTimers();
      const wasReady = ready;
      ws = null; ready = false; serverPeers = []; relayOk = false; failPending("Sin conexión con el servidor");
      if (wasReady) { if (room) endRoom("Se perdió la conexión con el servidor"); if (incoming) dismissIncoming(); }
      if (authFailed || code === 4003) { fail(g, "API key incorrecta", true); return; }
      if (code === 4001) { fail(g, "otro dispositivo usa el mismo ID; conexión cerrada", true); return; }
      if (wasReady) {
        setStatus("Sin conexión con el servidor; reintentando…", "err");
        if (cfg.enabled) { reconnectTimer = setTimeout(() => connect({}), backoff); backoff = Math.min(backoff * 2, 30000); }
        return;
      }
      const pr = await probeHttp(url);
      if (g !== gen) return;
      if (pr === "reachable") fail(g, "el servidor responde por HTTPS pero el WebSocket no se establece. Revisa que el proxy reenvíe /ws con las cabeceras Upgrade/Connection y que el servicio de llamadas esté en marcha", false);
      else if (pr === "timeout") fail(g, "el servidor no responde (tiempo de espera agotado)", false);
      else fail(g, "no se puede alcanzar el servidor (DNS, certificado TLS no válido, firewall o sin internet)", false);
    };
  }

  function onConnected(m) {
    clearTimers();
    ready = true; backoff = 1000; serverPeers = m.peers || []; relayOk = !!m.relay;
    const n = serverPeers.length;
    if (!cfg.enabled) {   // prueba puntual: el servidor está apagado en ajustes
      setStatus("Conectado ✓ (prueba correcta, pero el servidor está desactivado: activa el interruptor para usarlo)", "ok");
      if (curReport) { toast("Servidor — Conectado ✓ (desactivado en ajustes)", "ok", 6000); curReport = false; }
      closeWs(); return;
    }
    setStatus("Conectado ✓ · " + n + " en línea" + (relayOk ? "" : " (servidor antiguo: solo llamadas, actualízalo para chat y archivos)"), "ok");
    if (curReport) { toast("Servidor — Conectado ✓", "ok"); curReport = false; }
    try { SRV.onPeers && SRV.onPeers(serverPeers); } catch (e) {}
  }

  // ------------------------------------------------------------ estado de llamada
  let room = null;      // { id, video, iceServers, peers: Map, local, pending:Set, since, ringTimer, hadPeers, tick }
  let incoming = null;  // { room, from:{id,name}, video, members }
  let ring = null;
  let muted = false, camOff = false, speaker = false;
  const lanIp = {};     // id -> ip conocida por descubrimiento LAN (para candidatos mDNS)

  CC.serverBusy = () => !!(room || incoming);

  function onMsg(m) {
    switch (m.type) {
      case "welcome": return onConnected(m);
      case "peers":
        serverPeers = m.peers || [];
        if (ready && cfg.enabled) setStatus("Conectado ✓ · " + serverPeers.length + " en línea", "ok");
        pickerRefresh();
        try { SRV.onPeers && SRV.onPeers(serverPeers); } catch (e) {}
        return;
      case "relay": try { SRV.onRelay && SRV.onRelay(m.from, m.data); } catch (e) { console.error("[srv] relay", e); } return;
      case "relay_ack": { const p = pend.get(m.ref); if (p) { clearTimeout(p.t); pend.delete(m.ref); p.res(); } return; }
      case "relay_nack": { const p = pend.get(m.ref); if (p) { clearTimeout(p.t); pend.delete(m.ref); p.rej(new Error(NACK[m.code] || "No se pudo entregar")); } return; }
      case "error":
        if (m.code === "auth") authFailed = true;
        else if (m.code === "room_full" && room) endRoom("La sala está llena");
        else if (m.code === "rate_limited") flash("Demasiadas invitaciones, espera un momento");
        return;
      case "invite": return onInvite(m);
      case "invite_cancel": if (incoming && incoming.room === m.room) { dismissIncoming(); flash("Llamada perdida"); } return;
      case "invite_result": return onInviteResult(m);
      case "declined": return onDeclined(m);
      case "joined": return onJoined(m);
      case "peer_joined": return onPeerJoined(m);
      case "peer_left": return onPeerLeft(m);
      case "signal": return onSignal(m);
    }
  }

  // ------------------------------------------------------------ UI
  const ICO_PHONE = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>';
  const ICO_USERS = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';

  const ov = document.createElement("div");
  ov.id = "srvCall";
  ov.innerHTML =
    '<div class="srv-top"><div class="srv-title" id="srvTitle"></div><div class="srv-sub" id="srvSub"></div></div>' +
    '<div class="srv-center" id="srvCenter"></div>' +
    '<div class="srv-grid" id="srvGrid"></div>' +
    '<div class="srv-actions" id="srvActions"></div>';
  document.body.appendChild(ov);
  const elTitle = ov.querySelector("#srvTitle"), elSub = ov.querySelector("#srvSub");
  const elCenter = ov.querySelector("#srvCenter"), elGrid = ov.querySelector("#srvGrid"), elAct = ov.querySelector("#srvActions");

  const picker = document.createElement("div");
  picker.id = "srvPicker";
  picker.innerHTML = '<div class="srv-pk-box"><h3 id="srvPkTitle"></h3><div class="srv-pk-list" id="srvPkList"></div>' +
    '<label class="srv-pk-video" id="srvPkVideoRow"><input type="checkbox" id="srvPkVideo" /> Con video</label>' +
    '<div class="srv-pk-actions"><button class="call-btn dim" id="srvPkCancel">Cancelar</button><button class="call-btn green" id="srvPkOk">Llamar</button></div></div>';
  document.body.appendChild(picker);
  let pickerState = null;

  function btn(label, cls, fn) {
    const b = document.createElement("button");
    b.className = "call-btn " + cls; b.textContent = label; b.onclick = fn; return b;
  }
  const fmt = (s) => String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");

  let flashTimer = null;
  function flash(text) {
    if (room || incoming) { elSub.textContent = text; return; }
    ov.classList.add("show", "flash"); elTitle.textContent = text; elSub.textContent = "";
    elCenter.innerHTML = ""; elGrid.innerHTML = ""; elAct.innerHTML = "";
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (!room && !incoming) ov.classList.remove("show", "flash"); }, 2500);
  }

  function nameOf(id, fallback) {
    const p = serverPeers.find((x) => x.id === id);
    return (p && p.name) || fallback || "Contacto";
  }

  function render() {
    if (!room && !incoming) { ov.classList.remove("show", "flash"); return; }
    clearTimeout(flashTimer);
    ov.classList.add("show"); ov.classList.remove("flash");
    elAct.innerHTML = "";
    if (!room && incoming) {
      ov.classList.add("is-incoming");
      elTitle.textContent = incoming.from.name;
      elSub.textContent = (incoming.video ? "Videollamada" : "Llamada") + (incoming.members > 1 ? " grupal (" + incoming.members + " en la sala)" : " entrante");
      elCenter.innerHTML = '<div class="call-avatar">' + ICO_PHONE + '</div>'; elGrid.innerHTML = "";
      elAct.append(btn("Rechazar", "red", () => declineIncoming("declined")));
      if (incoming.video) elAct.append(btn("Solo audio", "dim", () => acceptIncoming(false)));
      elAct.append(btn("Contestar", "green", () => acceptIncoming(incoming.video)));
      return;
    }
    ov.classList.remove("is-incoming");
    elCenter.innerHTML = "";
    const n = room.peers.size;
    elTitle.textContent = n ? [...room.peers.values()].map((p) => p.name).join(", ") : "Llamando…";
    updateSub();
    elAct.append(btn(muted ? "Activar mic" : "Silenciar", "dim", () => {
      muted = !muted; if (room.local) room.local.getAudioTracks().forEach((t) => (t.enabled = !muted)); render();
    }));
    if (room.local && room.local.getVideoTracks().length) {
      elAct.append(btn(camOff ? "Activar cámara" : "Apagar cámara", "dim", () => {
        camOff = !camOff; room.local.getVideoTracks().forEach((t) => (t.enabled = !camOff)); render();
      }));
    }
    if (AB) elAct.append(btn("Altavoz", "dim" + (speaker ? " on" : ""), () => { speaker = !speaker; CC.setSpeaker(speaker); render(); }));
    elAct.append(btn("Añadir", "dim", () => openPicker({ title: "Añadir a la llamada", exclude: new Set([...room.peers.keys(), selfId]), showVideo: false, ok: "Invitar",
      onOk: (ids) => inviteMore(ids) })));
    elAct.append(btn("Colgar", "red", () => leaveRoom()));
  }

  function updateSub() {
    if (!room) return;
    clearInterval(room.tick);
    const connected = [...room.peers.values()].filter((p) => p.state === "connected").length;
    if (!connected) { elSub.textContent = room.peers.size ? "Conectando…" : "Esperando respuesta…"; return; }
    const t = () => { elSub.textContent = fmt(Math.max(0, Math.floor((Date.now() - room.since) / 1000))) + " · " + (room.peers.size + 1) + " participantes"; };
    t(); room.tick = setInterval(t, 1000);
  }

  // ---- selector de participantes
  function openPicker(opts) {
    pickerState = opts;
    picker.querySelector("#srvPkTitle").textContent = opts.title;
    picker.querySelector("#srvPkVideoRow").style.display = opts.showVideo ? "" : "none";
    picker.querySelector("#srvPkVideo").checked = false;
    picker.querySelector("#srvPkOk").textContent = opts.ok || "Llamar";
    picker.classList.add("show");
    pickerRefresh();
  }
  function pickerRefresh() {
    if (!pickerState) return;
    const list = picker.querySelector("#srvPkList");
    const keep = new Set([...list.querySelectorAll("input:checked")].map((i) => i.value));
    list.innerHTML = "";
    const people = serverPeers.filter((p) => !pickerState.exclude.has(p.id));
    if (!people.length) {
      const e = document.createElement("div"); e.className = "srv-pk-empty";
      e.textContent = serverReady() ? "No hay nadie más conectado al servidor." : "No hay conexión con el servidor.";
      list.appendChild(e);
    }
    for (const p of people) {
      const row = document.createElement("label"); row.className = "srv-pk-row";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.value = p.id; cb.checked = keep.has(p.id);
      const nm = document.createElement("span"); nm.textContent = p.name + (p.busy ? " (en llamada)" : "");
      row.append(cb, nm); list.appendChild(row);
    }
  }
  picker.querySelector("#srvPkCancel").onclick = () => { picker.classList.remove("show"); pickerState = null; };
  picker.querySelector("#srvPkOk").onclick = () => {
    const st = pickerState; if (!st) return;
    const ids = [...picker.querySelectorAll("#srvPkList input:checked")].map((i) => i.value);
    const video = picker.querySelector("#srvPkVideo").checked;
    picker.classList.remove("show"); pickerState = null;
    if (ids.length) st.onOk(ids, video);
  };

  // ------------------------------------------------------------ medios
  async function getMedia(video) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("sin acceso a medios");
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } : false,
    });
  }
  function startRing() { try { ring = new Audio("Incoming.mp3"); ring.loop = true; const p = ring.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
  function stopRing() { try { if (ring) { ring.pause(); ring = null; } } catch (e) {} }

  // ------------------------------------------------------------ llamadas salientes
  CC.route = function (peer, video) {
    if (!cfg.enabled || !serverReady()) return false;            // sin servidor: P2P
    if (!serverPeers.some((p) => p.id === peer.id)) return false; // el contacto no está en el servidor: P2P
    const R = window.ChatlanRelay;
    if (R && R.lanOnline && R.lanOnline(peer.id)) return false;   // está en mi LAN: llamada directa P2P (sin pasar por el servidor)
    if (CC.isBusy && CC.isBusy()) return true;
    if (room || incoming) return true;
    startRoomCall([peer.id], !!video);
    return true;
  };

  async function startRoomCall(ids, video) {
    if (room || incoming || (CC.isBusy && CC.isBusy())) return;
    const rid = uid();
    muted = false; camOff = false; speaker = !!(AB && video);
    room = newRoom(rid, !!video);
    room.pending = new Set(ids);
    render();
    try { room.local = await getMedia(video); }
    catch (e) { endRoom("No se pudo acceder al micrófono" + (video ? "/cámara" : "") + " (" + ((e && e.name) || e) + ")"); return; }
    if (!room || room.id !== rid) { if (room == null) return; }
    attachLocal();
    wsSend({ type: "rename", name: await selfName() });
    wsSend({ type: "join", room: rid, video: !!video });
    room.inviteIds = ids; room.inviteVideo = !!video;
    room.ringTimer = setTimeout(() => { if (room && room.id === rid && room.peers.size === 0) { leaveRoom("Sin respuesta"); } }, RING_MS);
    render();
  }

  function newRoom(id, video) {
    return { id, video, iceServers: [], peers: new Map(), local: null, pending: new Set(), since: 0, ringTimer: null, hadPeers: false, tick: null, joined: false, localTile: null };
  }

  function attachLocal() {
    if (!room || !room.local) return;
    if (!room.localTile) {
      const tile = document.createElement("div"); tile.className = "srv-tile local";
      const v = document.createElement("video"); v.autoplay = true; v.muted = true; v.setAttribute("playsinline", "");
      const lb = document.createElement("div"); lb.className = "srv-name"; lb.textContent = "Tú";
      tile.append(v, lb); elGrid.appendChild(tile);
      room.localTile = { tile, v };
    }
    room.localTile.v.srcObject = room.local;
    room.localTile.tile.classList.toggle("has-video", room.local.getVideoTracks().length > 0);
  }

  function onJoined(m) {
    if (!room || room.id !== m.room) return;
    room.joined = true; room.iceServers = m.iceServers || [];
    CC.audioOn && CC.audioOn(room.video);
    // el que entra ofrece a los que ya estaban
    for (const p of m.peers || []) { const pe = addPeer(p.id, p.name); offerTo(pe); }
    if (room.inviteIds) { wsSend({ type: "invite", room: room.id, to: room.inviteIds, video: room.inviteVideo }); room.inviteIds = null; }
    render();
  }

  function onInviteResult(m) {
    if (!room || room.id !== m.room) return;
    const notes = [];
    for (const id of m.offline || []) { room.pending.delete(id); notes.push(nameOf(id, "Un contacto") + " no está conectado al servidor"); }
    for (const id of m.busy || []) { room.pending.delete(id); notes.push(nameOf(id, "Un contacto") + " está ocupado"); }
    if (!room.pending.size && room.peers.size === 0) { leaveRoom(notes[0] || "Nadie disponible"); return; }
    if (notes.length) elSub.textContent = notes.join(" · ");
  }

  function onDeclined(m) {
    if (!room || room.id !== m.room) return;
    room.pending.delete(m.from);
    if (!room.pending.size && room.peers.size === 0) leaveRoom(m.reason === "busy" ? "Ocupado" : "Llamada rechazada");
    else elSub.textContent = (m.name || "Un contacto") + (m.reason === "busy" ? " está ocupado" : " rechazó la llamada");
  }

  // ------------------------------------------------------------ llamadas entrantes
  async function onInvite(m) {
    const from = m.from || {};
    if (room || incoming || (CC.isBusy && CC.isBusy())) {
      wsSend({ type: "decline", room: m.room, to: from.id, reason: "busy" });
      return;
    }
    incoming = { room: m.room, from: { id: from.id, name: String(from.name || "Contacto") }, video: !!m.video, members: m.members || 1 };
    startRing(); render();
    try { invoke("relay_notify", { msg: { kind: "Call", id: String(from.id), from: incoming.from.name, call_id: String(m.room), op: "invite", video: !!m.video, data: "" } }).catch(() => {}); } catch (e) {}
    try { const w = T.window.getCurrentWindow(); w.show(); w.unminimize(); w.setFocus(); } catch (e) {}
    const r = m.room;
    incoming.timer = setTimeout(() => { if (incoming && incoming.room === r) { dismissIncoming(); flash("Llamada perdida"); } }, RING_MS);
  }

  function dismissIncoming() {
    if (!incoming) return;
    clearTimeout(incoming.timer); stopRing();
    try { invoke("relay_notify", { msg: { kind: "Call", id: String(incoming.from.id), from: incoming.from.name, call_id: String(incoming.room), op: "end", video: false, data: "" } }).catch(() => {}); } catch (e) {}
    incoming = null; render();
  }
  function declineIncoming(reason) {
    if (!incoming) return;
    wsSend({ type: "decline", room: incoming.room, to: incoming.from.id, reason });
    dismissIncoming();
  }
  async function acceptIncoming(withVideo) {
    if (!incoming) return;
    const inc = incoming;
    clearTimeout(inc.timer); stopRing();
    muted = false; camOff = false; speaker = !!(AB && withVideo);
    room = newRoom(inc.room, !!withVideo); incoming = null;
    render();
    try { room.local = await getMedia(withVideo); }
    catch (e) {
      wsSend({ type: "decline", room: inc.room, to: inc.from.id, reason: "declined" });
      endRoom("No se pudo acceder al micrófono" + (withVideo ? "/cámara" : "") + " (" + ((e && e.name) || e) + ")"); return;
    }
    if (!room) { return; }
    attachLocal();
    wsSend({ type: "rename", name: await selfName() });
    wsSend({ type: "join", room: inc.room, video: !!withVideo });
    render();
  }

  function inviteMore(ids) {
    if (!room) return;
    ids.forEach((id) => room.pending.add(id));
    wsSend({ type: "invite", room: room.id, to: ids, video: room.video });
  }

  // ------------------------------------------------------------ malla WebRTC
  function addPeer(id, name) {
    let p = room.peers.get(id);
    if (p) return p;
    if (room.peers.size >= MAX_TILES) return null;
    p = { id, name: String(name || nameOf(id)), pc: null, stream: null, state: "new", pendingIce: [], remoteSet: false };
    const tile = document.createElement("div"); tile.className = "srv-tile";
    const v = document.createElement("video"); v.autoplay = true; v.setAttribute("playsinline", "");
    const lb = document.createElement("div"); lb.className = "srv-name"; lb.textContent = p.name;
    const stEl = document.createElement("div"); stEl.className = "srv-state"; stEl.textContent = "Conectando…";
    tile.append(v, lb, stEl); elGrid.appendChild(tile);
    p.tile = tile; p.v = v; p.stEl = stEl;
    room.peers.set(id, p);
    room.hadPeers = true; clearTimeout(room.ringTimer);
    ov.classList.toggle("multi", room.peers.size >= 2);
    return p;
  }

  function sigTo(id, obj) { if (room) wsSend({ type: "signal", room: room.id, to: id, data: JSON.stringify(obj) }); }

  function makePC(p) {
    const pc = new RTCPeerConnection({ iceServers: room.iceServers || [] });
    p.pc = pc;
    if (room.local) room.local.getTracks().forEach((t) => pc.addTrack(t, room.local));
    pc.onicecandidate = (e) => { if (e.candidate) sigTo(p.id, { k: "ice", c: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };
    pc.ontrack = (e) => {
      if (!p.stream) p.stream = new MediaStream();
      p.stream.addTrack(e.track);
      p.v.srcObject = p.stream;
      const pr = p.v.play(); if (pr && pr.catch) pr.catch(() => {});
      if (e.track.kind === "video") p.tile.classList.add("has-video");
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") {
        p.state = "connected"; p.stEl.textContent = "";
        if (!room.since) room.since = Date.now();
        updateSub();
      } else if (s === "failed") {
        p.state = "failed"; p.stEl.textContent = "Sin conexión (firewall/red)";
      } else if (s === "disconnected") {
        p.stEl.textContent = "Reconectando…";
      } else if (s === "connecting") {
        p.stEl.textContent = "Conectando…";
      }
    };
    return pc;
  }

  async function offerTo(p) {
    if (!p) return;
    try {
      const pc = makePC(p);
      const o = await pc.createOffer();
      await pc.setLocalDescription(o);
      sigTo(p.id, { k: "sdp", d: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    } catch (e) { console.error("[srv] offer", e); p.stEl.textContent = "Error (" + ((e && e.name) || e) + ")"; }
  }

  async function fixCand(id, c) {
    try {
      if (c && c.candidate && /\s[0-9a-f-]{8,}\.local\s/i.test(c.candidate)) {
        if (!lanIp[id]) {
          const list = await invoke("list_peers");
          (list || []).forEach((x) => { lanIp[x.id] = x.addr || (x.addrs && x.addrs[0]) || ""; });
        }
        if (lanIp[id]) return Object.assign({}, c, { candidate: c.candidate.replace(/\s[0-9a-f-]{8,}\.local(?=\s)/i, " " + lanIp[id]) });
      }
    } catch (e) {}
    return c;
  }

  async function flushIce(p) {
    const l = p.pendingIce; p.pendingIce = [];
    for (const c of l) { try { await p.pc.addIceCandidate(c); } catch (e) {} }
  }

  function onPeerJoined(m) {
    if (!room || m.room !== room.id) return;
    addPeer(m.id, m.name);           // el recién llegado nos ofrecerá
    room.pending.delete(m.id);
    render();
  }

  function onPeerLeft(m) {
    if (!room || m.room !== room.id) return;
    const p = room.peers.get(m.id);
    if (p) { try { p.pc && p.pc.close(); } catch (e) {} p.tile.remove(); room.peers.delete(m.id); }
    ov.classList.toggle("multi", room.peers.size >= 2);
    if (room.peers.size === 0 && room.hadPeers) { leaveRoom("Llamada finalizada"); return; }
    render();
  }

  async function onSignal(m) {
    if (!room || m.room !== room.id) return;
    let d; try { d = JSON.parse(m.data); } catch (e) { return; }
    let p = room.peers.get(m.from);
    if (!p) p = addPeer(m.from, nameOf(m.from));
    if (!p) return;
    try {
      if (d.k === "sdp") {
        if (!p.pc) makePC(p);
        await p.pc.setRemoteDescription(d.d);
        p.remoteSet = true; await flushIce(p);
        if (d.d.type === "offer") {
          const a = await p.pc.createAnswer();
          await p.pc.setLocalDescription(a);
          sigTo(p.id, { k: "sdp", d: { type: p.pc.localDescription.type, sdp: p.pc.localDescription.sdp } });
        }
      } else if (d.k === "ice") {
        const c = await fixCand(p.id, d.c);
        if (p.pc && p.remoteSet) { try { await p.pc.addIceCandidate(c); } catch (e) {} } else p.pendingIce.push(c);
      }
    } catch (e) { console.error("[srv] signal", e); p.stEl.textContent = "Error (" + ((e && e.name) || e) + ")"; }
  }

  // ------------------------------------------------------------ salir / limpiar
  function leaveRoom(reason) {
    if (room && room.joined !== false) wsSend({ type: "leave" });
    else if (room) wsSend({ type: "leave" });
    endRoom(reason || null);
  }

  function endRoom(reason) {
    const r = room; room = null;
    if (r) {
      clearTimeout(r.ringTimer); clearInterval(r.tick);
      r.peers.forEach((p) => { try { p.pc && p.pc.close(); } catch (e) {} });
      if (r.local) r.local.getTracks().forEach((t) => t.stop());
      CC.audioOff && CC.audioOff();
    }
    elGrid.innerHTML = ""; ov.classList.remove("multi", "is-incoming");
    muted = false; camOff = false; speaker = false;
    render();
    if (reason) flash(reason);
  }

  // ------------------------------------------------------------ llamada grupal (botón en contactos)
  function startGroup() {
    if (!serverReady()) { flash("Configura el servidor de llamadas en Ajustes"); return; }
    if (room || incoming || (CC.isBusy && CC.isBusy())) return;
    openPicker({ title: "Llamada grupal", exclude: new Set([selfId]), showVideo: true, ok: "Llamar",
      onOk: (ids, video) => startRoomCall(ids, video) });
  }

  const hdr = document.querySelector("#view-contacts .user-header");
  const gear = document.getElementById("settingsBtn");
  if (hdr && gear) {
    const b = document.createElement("button");
    b.id = "groupCallBtn"; b.className = "settings-gear"; b.title = "Llamada grupal"; b.innerHTML = ICO_USERS;
    b.onclick = startGroup;
    hdr.insertBefore(b, gear);
  }

  // ------------------------------------------------------------ ajustes
  const applyGroup = document.querySelector("#view-settings .settings-apply-group");
  if (applyGroup && applyGroup.parentElement) {
    const g = document.createElement("div");
    g.className = "settings-group";
    g.innerHTML =
      '<label class="settings-label">Servidor de llamadas (opcional)</label>' +
      '<input id="srvCfgUrl" class="input" placeholder="https://llamadas.midominio.com" autocomplete="off" spellcheck="false" />' +
      '<input id="srvCfgKey" class="input" type="password" placeholder="API key compartida" autocomplete="off" spellcheck="false" />' +
      '<label class="settings-label" style="display:flex;align-items:center;gap:10px;">Usar el servidor (chat, archivos y llamadas)' +
      '<span class="toggle"><input type="checkbox" id="srvCfgOn" /><span class="toggle-slider"></span></span></label>' +
      '<div class="srv-cfg-status" id="srvCfgStatus"></div>' +
      '<div class="srv-cfg-hint">Pulsa Aplicar para guardar y probar la conexión. Con el servidor verás a todos los conectados y podrás chatear, enviar archivos y llamar aunque no estén en tu red. En la misma LAN todo sigue yendo directo.</div>';
    applyGroup.parentElement.insertBefore(g, applyGroup);
    const u = g.querySelector("#srvCfgUrl"), k = g.querySelector("#srvCfgKey"), on = g.querySelector("#srvCfgOn");
    u.value = cfg.url; k.value = cfg.key; on.checked = cfg.enabled;
    setStatus(statusText, statusKind);
    const applyBtn = document.getElementById("settingsApplyBtn");
    if (applyBtn) applyBtn.addEventListener("click", () => {
      cfg = { url: u.value.trim(), key: k.value.trim(), enabled: on.checked };
      saveCfg(); backoff = 1000;
      if (cfg.url || cfg.key) connect({ test: true, report: true });
      else { closeWs(); setStatus("Desactivado"); }
    });
  }

  if (cfg.enabled) connect({});
})();
