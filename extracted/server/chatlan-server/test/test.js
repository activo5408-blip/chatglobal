'use strict';
// Prueba de integración: levanta el servidor y conecta clientes reales (WebSocket nativo de Node >= 22).
process.env.API_KEY = 'k'.repeat(32);
process.env.MAX_ROOM = '3';
process.env.TURN_URLS = 'turn:turn.example.com:3478';
process.env.TURN_SECRET = 'secreto-de-prueba';
process.env.INVITE_TTL_MS = '400';
const assert = require('assert');
const { server } = require('../server.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port;
function client(label) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data); inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  };
  const open = new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws error ' + label)); });
  return {
    ws, inbox, open,
    send: (o) => ws.send(JSON.stringify(o)),
    wait: (type, pred = () => true, ms = 1500) => new Promise((res, rej) => {
      const hit = inbox.find((m) => m.type === type && pred(m)); if (hit) return res(hit);
      const w = { pred: (m) => m.type === type && pred(m), res };
      waiters.push(w);
      setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`${label}: timeout esperando ${type}`)); } }, ms);
    }),
    has: (type) => inbox.some((m) => m.type === type),
  };
}
const KEY = 'k'.repeat(32);
const ID = (c) => c.repeat(12);
async function login(label, idc, key = KEY) {
  const c = client(label); await c.open;
  c.send({ type: 'hello', key, id: ID(idc), name: label });
  return c;
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  let n = 0; const ok = (m) => console.log(`  ok ${++n} - ${m}`);

  // 1) API key incorrecta
  const bad = await login('bad', 'x', 'incorrecta');
  const err = await bad.wait('error'); assert.strictEqual(err.code, 'auth'); ok('API key incorrecta rechazada');

  // 2) autenticación y presencia
  const A = await login('Ana', 'a'); await A.wait('welcome');
  const B = await login('Beto', 'b'); await B.wait('welcome');
  const peersA = await A.wait('peers', (m) => m.peers.length === 1);
  assert.strictEqual(peersA.peers[0].name, 'Beto'); ok('presencia entre clientes');

  // 3) join + invitación 1:1
  A.send({ type: 'join', room: 'sala-0001', video: true });
  const jA = await A.wait('joined'); assert.deepStrictEqual(jA.peers, []);
  assert.ok(jA.iceServers[0].username && jA.iceServers[0].credential); ok('join y credenciales TURN efímeras');
  const exp = parseInt(jA.iceServers[0].username, 10); assert.ok(exp > Date.now() / 1000);
  A.send({ type: 'invite', room: 'sala-0001', to: [ID('b'), ID('z')], video: true });
  const inv = await B.wait('invite'); assert.strictEqual(inv.from.name, 'Ana'); assert.strictEqual(inv.video, true);
  const res = await A.wait('invite_result'); assert.deepStrictEqual(res.delivered, [ID('b')]); assert.deepStrictEqual(res.offline, [ID('z')]);
  ok('invitación entregada / destinatario offline detectado');

  B.send({ type: 'join', room: 'sala-0001' });
  const jB = await B.wait('joined'); assert.strictEqual(jB.peers.length, 1); assert.strictEqual(jB.peers[0].id, ID('a'));
  const pj = await A.wait('peer_joined'); assert.strictEqual(pj.id, ID('b')); ok('segundo participante entra a la sala');

  // 4) señalización WebRTC
  B.send({ type: 'signal', room: 'sala-0001', to: ID('a'), data: JSON.stringify({ k: 'offer' }) });
  const sg = await A.wait('signal'); assert.strictEqual(sg.from, ID('b')); assert.deepStrictEqual(JSON.parse(sg.data), { k: 'offer' });
  ok('señal SDP/ICE reenviada');

  const big = 'x'.repeat(30000);
  A.send({ type: 'signal', room: 'sala-0001', to: ID('b'), data: big });
  const sgBig = await B.wait('signal', (m) => m.data.length === 30000); assert.ok(sgBig); ok('mensajes grandes (longitud de 16 bit) en ambos sentidos');

  // 5) un tercero fuera de la sala no puede inyectar señales
  const C = await login('Carla', 'c'); await C.wait('welcome');
  C.send({ type: 'signal', room: 'sala-0001', to: ID('a'), data: '{}' });
  await sleep(150); assert.strictEqual(A.inbox.filter((m) => m.type === 'signal').length, 1); ok('señales de ajenos a la sala ignoradas');

  // 6) sala grupal y límite
  C.send({ type: 'join', room: 'sala-0001' }); const jC = await C.wait('joined'); assert.strictEqual(jC.peers.length, 2);
  const D = await login('Dani', 'd'); await D.wait('welcome');
  D.send({ type: 'join', room: 'sala-0001' }); const full = await D.wait('error', (m) => m.code === 'room_full'); assert.ok(full); ok('límite de participantes por sala');

  // 7) salir
  B.send({ type: 'leave' }); const pl = await A.wait('peer_left'); assert.strictEqual(pl.id, ID('b')); ok('peer_left al salir');

  // 8) decline + cancelación de invitaciones cuando la sala se vacía
  const E = await login('Eli', 'e'); await E.wait('welcome');
  A.send({ type: 'invite', room: 'sala-0001', to: [ID('e')], video: false }); await E.wait('invite');
  E.send({ type: 'decline', room: 'sala-0001', to: ID('a'), reason: 'busy' });
  const dec = await A.wait('declined'); assert.strictEqual(dec.name, 'Eli'); ok('rechazo notificado al que invita');
  A.send({ type: 'invite', room: 'sala-0001', to: [ID('e')], video: false }); await E.wait('invite', () => true);
  await E.wait('invite_cancel', () => true, 1500); ok('invitación caduca y se cancela');

  // 9) sala vacía -> invitaciones pendientes canceladas
  const F = await login('Fer', 'f'); await F.wait('welcome');
  const G = await login('Gus', 'g'); await G.wait('welcome');
  F.send({ type: 'join', room: 'sala-0002' }); await F.wait('joined');
  F.send({ type: 'invite', room: 'sala-0002', to: [ID('g')] }); await G.wait('invite');
  F.send({ type: 'leave' });
  await G.wait('invite_cancel'); ok('si el que llama cuelga, el invitado deja de sonar');

  // 10) desconexión limpia sale de la sala
  A.ws.close(); C.send({ type: 'list' });
  await C.wait('peer_left', (m) => m.id === ID('a')); ok('desconexión abrupta limpia la sala');

  // 11) salas con id inválido
  const H = await login('Hugo', 'h'); await H.wait('welcome');
  H.send({ type: 'join', room: '../x' }); await H.wait('error', (m) => m.code === 'bad_room'); ok('id de sala inválido rechazado');

  // 12) relay: chat/archivos/avatar entre usuarios del servidor (como en la LAN) con remitente fijado por el servidor
  const R1 = await login('Rita', 'r'); const w1 = await R1.wait('welcome'); assert.strictEqual(w1.relay, true);
  const R2 = await login('Raul', 's'); await R2.wait('welcome');
  R1.send({ type: 'relay', to: ID('s'), ref: 'r1', ack: true, data: JSON.stringify({ kind: 'Text', id: 'suplantado', body: 'hola' }) });
  const rl = await R2.wait('relay'); assert.strictEqual(rl.from, ID('r')); assert.strictEqual(JSON.parse(rl.data).body, 'hola');
  await R1.wait('relay_ack', (m) => m.ref === 'r1'); ok('relay entregado, con remitente real y acuse');
  R1.send({ type: 'relay', to: ID('q'), ref: 'r2', data: '{}' });
  const nk = await R1.wait('relay_nack', (m) => m.ref === 'r2'); assert.strictEqual(nk.code, 'offline'); ok('relay a usuario desconectado devuelve nack');
  R1.send({ type: 'relay', to: ID('s'), ref: 'r3', data: 'x'.repeat(50 * 1024) });
  const bigNk = await R1.wait('relay_nack', (m) => m.ref === 'r3'); assert.strictEqual(bigNk.code, 'bad_request'); ok('relay demasiado grande rechazado');
  let limited = 0; for (let i = 0; i < 1000; i++) R1.send({ type: 'relay', to: ID('s'), ref: 'f' + i, data: '{}' });
  await sleep(500); limited = R1.inbox.filter((m) => m.type === 'relay_nack' && m.code === 'rate_limited').length;
  assert.ok(limited > 0); ok('limite de ritmo en relay');

  // 13) sin duplicados: el mismo ID conectado dos veces deja una sola entrada
  const D1 = await login('Dani', 'd'); await D1.wait('welcome');
  const D2 = await login('Dani', 'd'); await D2.wait('welcome');
  const rep = await D1.wait('error', (m) => m.code === 'replaced'); assert.ok(rep);
  R2.send({ type: 'list' });
  const lst = await R2.wait('peers', (m) => m.peers.filter((p) => p.id === ID('d')).length === 1 && m.peers.some((p) => p.id === ID('d')));
  assert.strictEqual(lst.peers.filter((p) => p.id === ID('d')).length, 1); ok('mismo ID no se duplica; la sesion nueva reemplaza a la vieja');

  console.log(`\nTodo OK (${n} comprobaciones)`);
  process.exit(0);
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
