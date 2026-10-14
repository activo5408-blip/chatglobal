#!/usr/bin/env node
'use strict';
// Comprueba un servidor de llamadas de ChatLAN desde tu PC:  node check.js <url> <api-key>
// (Node >= 22). Ejemplo: node check.js https://chatlan.midominio.com TU_API_KEY
const [, , rawUrl, key] = process.argv;
if (!rawUrl || !key) { console.log('Uso: node check.js <url-del-servidor> <api-key>'); process.exit(2); }
const say = (ok, msg) => console.log((ok ? '  [OK]   ' : '  [FALLO] ') + msg);

let wsUrl, httpUrl;
try {
  let s = rawUrl.trim();
  if (/^https?:\/\//i.test(s)) s = s.replace(/^http/i, 'ws'); else if (!/^wss?:\/\//i.test(s)) s = 'wss://' + s;
  const u = new URL(s); if (!u.pathname || u.pathname === '/') u.pathname = '/ws';
  wsUrl = u.toString();
  const h = new URL(wsUrl); h.protocol = h.protocol === 'wss:' ? 'https:' : 'http:'; h.pathname = '/'; httpUrl = h.toString();
} catch (e) { say(false, 'URL no válida: ' + e.message); process.exit(1); }

(async () => {
  console.log('Servidor: ' + wsUrl);
  // 1) HTTP(S)
  try {
    const r = await fetch(httpUrl, { signal: AbortSignal.timeout(8000) });
    const body = (await r.text()).trim().slice(0, 60);
    say(true, `Responde por HTTP(S): ${r.status} "${body}"`);
    if (!/ChatLAN call server/i.test(body)) console.log('         (aviso: la raíz no responde "ChatLAN call server"; puede ser otro servicio detrás del dominio. Lo importante es la ruta /ws)');
  } catch (e) {
    say(false, 'No se puede alcanzar el servidor: ' + (e.cause && e.cause.code || e.name) + ' (DNS, certificado TLS, firewall o sin internet)');
    process.exit(1);
  }
  // 2) WebSocket + API key
  const result = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ kind: 'noproto' }), 8000);
    let ws; try { ws = new WebSocket(wsUrl); } catch (e) { clearTimeout(t); return resolve({ kind: 'ws-error', detail: e.message }); }
    let opened = false;
    ws.onopen = () => { opened = true; ws.send(JSON.stringify({ type: 'hello', key, id: 'check' + Math.random().toString(36).slice(2, 12), name: 'check.js' })); };
    ws.onerror = () => { if (!opened) { clearTimeout(t); resolve({ kind: 'ws-error' }); } };
    ws.onclose = (e) => { clearTimeout(t); resolve({ kind: e.code === 4003 ? 'auth' : opened ? 'closed' : 'ws-error', code: e.code }); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.type === 'welcome') {
        // probar también una sala para ver si hay credenciales TURN
        ws.send(JSON.stringify({ type: 'join', room: 'check-' + Date.now() }));
      } else if (m.type === 'joined') { clearTimeout(t); resolve({ kind: 'ok', welcomePeers: 0, ice: m.iceServers || [] }); ws.close(); }
      else if (m.type === 'error') { clearTimeout(t); resolve({ kind: m.code === 'auth' ? 'auth' : 'error', detail: m.code }); }
    };
  });
  switch (result.kind) {
    case 'ok': {
      say(true, 'WebSocket abierto y API key aceptada');
      const turn = result.ice.find((s) => s.username);
      say(true, turn ? 'TURN configurado (credenciales efímeras entregadas)' : 'Sin TURN configurado (las llamadas solo funcionan si hay ruta directa entre los equipos)');
      process.exit(0);
    }
    case 'auth': say(false, 'API key incorrecta (el servidor respondió pero la rechazó)'); break;
    case 'noproto': say(false, 'La conexión se abre pero no responde como servidor de llamadas de ChatLAN (¿otro servicio o ruta /ws sin proxy al servicio correcto?)'); break;
    case 'ws-error': say(false, 'El HTTP responde pero el WebSocket no se establece. Revisa que el proxy reenvíe /ws con Upgrade/Connection ' + (result.detail || '')); break;
    default: say(false, 'Respuesta inesperada: ' + JSON.stringify(result));
  }
  process.exit(1);
})();
