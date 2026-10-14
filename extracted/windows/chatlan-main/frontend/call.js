// Llamadas de voz y videollamadas por WebRTC. Mismo archivo en Windows (Tauri) y Android (WebView).
// Señalización: mensaje "Call" por el canal TCP del chat (send_call / poll_messages). Sin STUN/TURN: solo LAN.
(function () {
  "use strict";
  const T = window.__TAURI__;
  if (!T || !T.core) return;
  const invoke = T.core.invoke;
  const AB = window.AndroidBridge || null; // solo en Android
  const RING_MS = 45000;

  let st = "idle"; // idle | outgoing | incoming | connecting | active
  let callId = "", peer = null, wantVideo = false;
  let pc = null, local = null, remoteStream = null, remoteHasVideo = false;
  let pendingIce = [], remoteSet = false;
  let ringTimer = null, tickTimer = null, discTimer = null, since = 0, ring = null;
  let muted = false, camOff = false, speaker = false;
  let sendQ = Promise.resolve();

  const dec = (s) => (AB ? String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : String(s || ""));
  const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const fmt = (s) => String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");

  const PHONE = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>';
  const CAM = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>';

  // ---------- señalización ----------
  let lastErr = "";
  function send(op, data, toId, cid) {
    const target = toId || (peer && peer.id);
    if (!target) return Promise.resolve(false);
    const args = { peerId: target, callId: cid || callId, op: op, video: wantVideo, data: data == null ? "" : JSON.stringify(data) };
    const run = () => invoke("send_call", args).then(() => true, (e) => { lastErr = String(e); console.error("[call] send_call", op, e); return false; });
    const r = sendQ.then(run);
    sendQ = r;
    return r;
  }

  // ---------- UI ----------
  const ov = document.createElement("div");
  ov.id = "callOverlay";
  ov.innerHTML =
    '<video id="callRemote" autoplay playsinline></video>' +
    '<video id="callLocal" autoplay playsinline muted></video>' +
    '<div class="call-info"><div class="call-avatar">' + PHONE + '</div>' +
    '<div class="call-name" id="callName"></div><div class="call-status" id="callStatus"></div></div>' +
    '<div class="call-actions" id="callActions"></div>';
  document.body.appendChild(ov);
  const vRemote = ov.querySelector("#callRemote");
  const vLocal = ov.querySelector("#callLocal");
  const nameEl = ov.querySelector("#callName");
  const statusEl = ov.querySelector("#callStatus");
  const actEl = ov.querySelector("#callActions");

  function btn(label, cls, fn) {
    const b = document.createElement("button");
    b.className = "call-btn " + cls;
    b.textContent = label;
    b.onclick = fn;
    return b;
  }

  function render() {
    ov.classList.toggle("show", st !== "idle");
    ov.classList.toggle("has-video", st === "active" && remoteHasVideo);
    ov.classList.toggle("has-local", !!(local && local.getVideoTracks().length) && st !== "incoming");
    nameEl.textContent = peer ? peer.name : "";
    actEl.innerHTML = "";
    if (st === "outgoing") {
      statusEl.textContent = "Llamando…";
      actEl.append(btn("Colgar", "red", hangup));
    } else if (st === "incoming") {
      statusEl.textContent = wantVideo ? "Videollamada entrante" : "Llamada entrante";
      actEl.append(btn("Rechazar", "red", hangup));
      if (wantVideo) actEl.append(btn("Solo audio", "dim", () => accept(false)));
      actEl.append(btn(wantVideo ? "Contestar" : "Contestar", "green", () => accept(wantVideo)));
    } else if (st === "connecting") {
      statusEl.textContent = "Conectando…";
      actEl.append(btn("Colgar", "red", hangup));
    } else if (st === "active") {
      const tick = () => { statusEl.textContent = fmt(Math.max(0, Math.floor((Date.now() - since) / 1000))); };
      tick();
      clearInterval(tickTimer); tickTimer = setInterval(tick, 1000);
      const mb = btn(muted ? "Activar mic" : "Silenciar", "dim", () => {
        muted = !muted; mb.textContent = muted ? "Activar mic" : "Silenciar";
        if (local) local.getAudioTracks().forEach((t) => (t.enabled = !muted));
      });
      actEl.append(mb);
      if (local && local.getVideoTracks().length) {
        const cb = btn(camOff ? "Activar cámara" : "Apagar cámara", "dim", () => {
          camOff = !camOff; cb.textContent = camOff ? "Activar cámara" : "Apagar cámara";
          local.getVideoTracks().forEach((t) => (t.enabled = !camOff));
        });
        actEl.append(cb);
      }
      if (AB) {
        const sb = btn("Altavoz", "dim" + (speaker ? " on" : ""), () => {
          speaker = !speaker; sb.classList.toggle("on", speaker);
          invoke("call_speaker", { on: speaker }).catch(() => {});
        });
        actEl.append(sb);
      }
      actEl.append(btn("Colgar", "red", hangup));
    }
  }

  function flash(text, name) {
    // aviso breve tras terminar (cuando ya estamos idle)
    ov.classList.add("show");
    ov.classList.remove("has-video", "has-local");
    nameEl.textContent = name || "";
    statusEl.textContent = text;
    actEl.innerHTML = "";
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { if (st === "idle") ov.classList.remove("show"); }, 2200);
  }

  // ---------- ciclo de vida ----------
  function startRing() {
    try { ring = new Audio("Incoming.mp3"); ring.loop = true; const p = ring.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  }
  function stopRing() { try { if (ring) { ring.pause(); ring = null; } } catch (e) {} }

  function cleanup(reason) {
    const name = peer ? peer.name : "";
    clearTimeout(ringTimer); clearTimeout(discTimer); clearInterval(tickTimer);
    stopRing();
    try { if (pc) { pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = null; pc.close(); } } catch (e) {}
    pc = null;
    if (local) local.getTracks().forEach((t) => t.stop());
    local = null; remoteStream = null; remoteHasVideo = false;
    vRemote.srcObject = null; vLocal.srcObject = null;
    pendingIce = []; remoteSet = false; peerIpCache = null; muted = false; camOff = false; speaker = false;
    const wasActive = st === "active";
    st = "idle"; peer = null; callId = "";
    if (AB && wasActive) {
      invoke("call_fgs", { on: false }).catch(() => {});
      invoke("call_audio", { on: false, speaker: false }).catch(() => {});
    }
    if (reason) flash(reason, name); else ov.classList.remove("show");
  }

  function goActive() {
    if (st === "active") return;
    clearTimeout(ringTimer);
    stopRing();
    st = "active";
    since = Date.now();
    speaker = !!(AB && wantVideo);
    if (AB) {
      invoke("call_fgs", { on: true }).catch(() => {});
      invoke("call_audio", { on: true, speaker: speaker }).catch(() => {});
    }
    render();
  }

  function hangup() {
    if (st === "idle") return;
    send(st === "incoming" ? "reject" : "end");
    cleanup(null);
  }

  async function getMedia(video) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("sin acceso a medios");
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } : false,
    });
  }

  function createPC() {
    pc = new RTCPeerConnection({ iceServers: [] });
    local.getTracks().forEach((t) => pc.addTrack(t, local));
    pc.onicecandidate = (e) => { if (e.candidate) send("ice", e.candidate.toJSON ? e.candidate.toJSON() : e.candidate); };
    pc.ontrack = (e) => {
      if (!remoteStream) remoteStream = new MediaStream();
      remoteStream.addTrack(e.track);
      if (e.track.kind === "video") remoteHasVideo = true;
      vRemote.srcObject = remoteStream;
      const p = vRemote.play(); if (p && p.catch) p.catch(() => {});
      render();
    };
    pc.oniceconnectionstatechange = () => {
      console.log("[call] ice:", pc && pc.iceConnectionState);
      if (st === "connecting" && pc) statusEl.textContent = "Conectando… (" + pc.iceConnectionState + ")";
    };
    pc.onconnectionstatechange = () => {
      const s = pc && pc.connectionState;
      if (s === "connected") { clearTimeout(discTimer); goActive(); }
      else if (s === "failed") { send("end"); cleanup("Se perdió la conexión (revisa el firewall y que ambos estén en la misma red)"); }
      else if (s === "disconnected") {
        clearTimeout(discTimer);
        discTimer = setTimeout(() => {
          if (pc && (pc.connectionState === "disconnected" || pc.connectionState === "failed")) { send("end"); cleanup("Se perdió la conexión (revisa el firewall y que ambos estén en la misma red)"); }
        }, 8000);
      }
    };
  }

  let peerIpCache = null;
  async function fixCand(c) {
    try {
      if (c && c.candidate && /\s[0-9a-f-]{8,}\.local\s/i.test(c.candidate)) {
        if (!peerIpCache) {
          const list = await invoke("list_peers");
          const p = (list || []).find((x) => peer && x.id === peer.id);
          peerIpCache = p && (p.addr || (p.addrs && p.addrs[0]));
        }
        if (peerIpCache) return Object.assign({}, c, { candidate: c.candidate.replace(/\s[0-9a-f-]{8,}\.local(?=\s)/i, " " + peerIpCache) });
      }
    } catch (e) { console.error("[call] fixCand", e); }
    return c;
  }

  async function flushIce() {
    const list = pendingIce; pendingIce = [];
    for (const c of list) { try { await pc.addIceCandidate(c); } catch (e) {} }
  }

  // ---------- acciones ----------
  async function startCall(p, video) {
    if (st !== "idle") return;
    const myId = uid();
    callId = myId; peer = { id: p.id, name: p.name }; wantVideo = !!video; st = "outgoing";
    render();
    try {
      local = await getMedia(wantVideo);
    } catch (e) {
      if (callId === myId) cleanup("No se pudo acceder al micrófono" + (wantVideo ? "/cámara" : "") + " (" + ((e && e.name) || e) + ")");
      return;
    }
    if (callId !== myId || st !== "outgoing") { if (local) local.getTracks().forEach((t) => t.stop()); return; }
    vLocal.srcObject = local;
    render();
    const ok = await send("invite");
    if (callId !== myId) return;
    if (!ok) { cleanup("No se pudo contactar" + (lastErr ? ": " + lastErr : "")); return; }
    ringTimer = setTimeout(() => { if (callId === myId && st === "outgoing") { send("end"); cleanup("Sin respuesta (¿tiene la versión nueva con llamadas?)"); } }, RING_MS);
  }

  async function accept(withVideo) {
    if (st !== "incoming") return;
    const myId = callId;
    st = "connecting"; stopRing(); clearTimeout(ringTimer); render();
    try {
      local = await getMedia(!!withVideo);
    } catch (e) {
      send("reject"); cleanup("No se pudo acceder al micrófono" + (withVideo ? "/cámara" : "") + " (" + ((e && e.name) || e) + ")"); return;
    }
    if (callId !== myId || st !== "connecting") { if (local) local.getTracks().forEach((t) => t.stop()); return; }
    vLocal.srcObject = local;
    createPC();
    render();
    ringTimer = setTimeout(() => { if (callId === myId && st === "connecting") { send("end"); cleanup("No se pudo conectar"); } }, 30000);
    send("accept");
  }

  function nameOf(id, fallback) {
    try { if (typeof peers !== "undefined") { const p = peers.find((x) => x.id === id); if (p && p.name) return dec(p.name); } } catch (e) {}
    return dec(fallback) || "Contacto";
  }

  async function onCall(msg) {
    const op = msg.op, cid = msg.call_id;
    if (op === "invite") {
      if (st !== "idle" || (window.ChatlanCall && window.ChatlanCall.serverBusy && window.ChatlanCall.serverBusy())) {
        await send("reject", { reason: "busy" }, msg.id, cid);
        return;
      }
      callId = cid; peer = { id: msg.id, name: nameOf(msg.id, msg.from) }; wantVideo = !!msg.video; st = "incoming";
      startRing(); render();
      try { const w = T.window.getCurrentWindow(); w.show(); w.unminimize(); w.setFocus(); } catch (e) {}
      ringTimer = setTimeout(() => { if (callId === cid && st === "incoming") { cleanup("Llamada perdida"); } }, RING_MS);
      return;
    }
    if (!peer || cid !== callId || msg.id !== peer.id) return;
    if (op === "accept" && st === "outgoing") {
      clearTimeout(ringTimer);
      st = "connecting"; render();
      try {
        createPC();
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send("sdp", { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
        ringTimer = setTimeout(() => { if (callId === cid && st === "connecting") { send("end"); cleanup("No se pudo conectar"); } }, 30000);
      } catch (e) { console.error("[call] offer", e); send("end"); cleanup("Error al iniciar la llamada (" + ((e && e.name) || e) + ")"); }
    } else if (op === "sdp") {
      let d; try { d = JSON.parse(msg.data); } catch (e) { return; }
      if (!pc) return;
      try {
        await pc.setRemoteDescription(d);
        remoteSet = true;
        await flushIce();
        if (d.type === "offer") {
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          send("sdp", { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
        }
      } catch (e) { console.error("[call] sdp", e); send("end"); cleanup("Error de conexión (" + ((e && e.name) || e) + ")"); }
    } else if (op === "ice") {
      let c; try { c = JSON.parse(msg.data); } catch (e) { return; }
      c = await fixCand(c);
      if (pc && remoteSet) { try { await pc.addIceCandidate(c); } catch (e) {} } else pendingIce.push(c);
    } else if (op === "reject") {
      let r = {}; try { r = JSON.parse(msg.data || "{}"); } catch (e) {}
      cleanup(r.reason === "busy" ? "Ocupado" : "Llamada rechazada");
    } else if (op === "end") {
      cleanup(st === "incoming" ? "Llamada perdida" : "Llamada finalizada");
    }
  }

  // ---------- enganche con app.js ----------
  const orig = window.handleIncoming;
  if (typeof orig === "function") {
    window.handleIncoming = function (msg) {
      if (msg && msg.kind === "Call") { onCall(msg); return; }
      return orig.apply(this, arguments);
    };
  }

  // ---------- API para callserver.js ----------
  window.ChatlanCall = Object.assign(window.ChatlanCall || {}, {
    isBusy: () => st !== "idle",
    audioOn: (video) => {
      if (!AB) return;
      invoke("call_fgs", { on: true }).catch(() => {});
      invoke("call_audio", { on: true, speaker: !!video }).catch(() => {});
    },
    audioOff: () => {
      if (!AB) return;
      invoke("call_fgs", { on: false }).catch(() => {});
      invoke("call_audio", { on: false, speaker: false }).catch(() => {});
    },
    setSpeaker: (on) => { if (AB) invoke("call_speaker", { on: !!on }).catch(() => {}); },
  });

  // ---------- botones en la cabecera del chat ----------
  const menu = document.getElementById("chatMenuBtn");
  if (menu && menu.parentElement) {
    const mk = (id, title, html, video) => {
      const b = document.createElement("button");
      b.id = id; b.title = title; b.className = "call-hdr-btn"; b.innerHTML = html;
      b.onclick = (ev) => {
        ev.stopPropagation();
        const p = (typeof activePeer !== "undefined") ? activePeer : null;
        if (!p) return;
        const CC = window.ChatlanCall;
        if (CC && CC.route && CC.route(p, video)) return;
        startCall(p, video);
      };
      return b;
    };
    menu.parentElement.insertBefore(mk("callBtn", "Llamar", PHONE, false), menu);
    menu.parentElement.insertBefore(mk("videoCallBtn", "Videollamada", CAM, true), menu);
  }
})();
