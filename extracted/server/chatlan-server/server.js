'use strict';
/**
 * ChatLAN Call Server — señalización para llamadas, videollamadas y llamadas grupales (malla WebRTC)
 * + credenciales TURN efímeras (coturn). Sin dependencias: solo Node.js >= 18.
 *
 * Todas las apps comparten una misma API_KEY. No hay registro de usuarios.
 * El audio/vídeo NO pasa por este proceso: viaja entre los clientes (o por coturn si se configura).
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

// ---------------------------------------------------------------- configuración
const env = process.env;
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const CFG = {
  port: parseInt(env.PORT || '8443', 10),
  host: env.HOST || '0.0.0.0',
  apiKey: env.API_KEY || '',
  maxRoom: Math.max(2, parseInt(env.MAX_ROOM || '6', 10)),
  stunUrls: list(env.STUN_URLS),
  turnUrls: list(env.TURN_URLS),
  turnSecret: env.TURN_SECRET || '',
  turnTtl: parseInt(env.TURN_TTL || '86400', 10),
  tlsCert: env.TLS_CERT || '',
  tlsKey: env.TLS_KEY || '',
  trustProxy: env.TRUST_PROXY === '1',
  maxConnsPerIp: parseInt(env.MAX_CONNS_PER_IP || '20', 10),
  inviteTtlMs: parseInt(env.INVITE_TTL_MS || '60000', 10),
};
if (CFG.apiKey.length < 16) {
  console.error('Falta API_KEY (minimo 16 caracteres). Genera una con:  openssl rand -hex 32');
  process.exit(1);
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const KEY_HASH = sha256(CFG.apiKey);
const keyOk = (k) => typeof k === 'string' && k.length <= 256 && crypto.timingSafeEqual(sha256(k), KEY_HASH);

const MAX_FRAME = 64 * 1024;     // tamaño máx. de un mensaje
const MAX_RELAY_DATA = 48 * 1024; // carga útil máx. de un mensaje 'relay' (los clientes fragmentan lo grande)
const MAX_BACKLOG = 8 * 1024 * 1024; // bytes pendientes de escribir a un cliente lento antes de cortarlo
const RELAY_BURST = 600, RELAY_RATE = 300; // cubo de fichas por conexión: ráfaga y mensajes/seg
const AUTH_TIMEOUT_MS = 5000;
const PING_MS = 25000;
const RE_ID = /^[0-9A-Za-z_-]{8,64}$/;
const RE_ROOM = /^[0-9A-Za-z_-]{6,64}$/;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- estado
const clients = new Map();   // id -> Conn (autenticados)
const rooms = new Map();     // room -> { id, video, members: Map<id,Conn>, invited: Map<id, timer> }
const connsPerIp = new Map();
const authFails = new Map(); // ip -> { n, first, blockedUntil }

function iceServers(id) {
  const out = [];
  if (CFG.stunUrls.length) out.push({ urls: CFG.stunUrls });
  if (CFG.turnUrls.length && CFG.turnSecret) {
    const username = Math.floor(Date.now() / 1000) + CFG.turnTtl + ':' + id;
    const credential = crypto.createHmac('sha1', CFG.turnSecret).update(username).digest('base64');
    out.push({ urls: CFG.turnUrls, username, credential });
  }
  return out;
}

// ---------------------------------------------------------------- WebSocket mínimo (RFC 6455)
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(op, payload) {
  const len = payload.length;
  let h;
  if (len < 126) h = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([h, payload]);
}

class Conn {
  constructor(socket, ip) {
    this.s = socket; this.ip = ip;
    this.buf = Buffer.alloc(0);
    this.fragOp = 0; this.frag = []; this.fragLen = 0;
    this.closed = false; this.alive = true;
    this.id = null; this.name = ''; this.room = null; this.authed = false;
    this.inviteTimes = [];
    this.tokens = RELAY_BURST; this.tokenAt = Date.now();
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.onClose());
    socket.on('error', () => this.onClose());
    this.authTimer = setTimeout(() => this.close(4003, 'auth timeout'), AUTH_TIMEOUT_MS);
  }
  send(obj) {
    if (this.closed) return false;
    if (this.s.writableLength > MAX_BACKLOG) { this.close(1013, 'slow consumer'); return false; }
    try { this.s.write(frame(0x1, Buffer.from(JSON.stringify(obj)))); return true; } catch (_) { return false; }
  }
  take() {   // limitador de ritmo para 'relay'
    const now = Date.now();
    this.tokens = Math.min(RELAY_BURST, this.tokens + (now - this.tokenAt) * RELAY_RATE / 1000);
    this.tokenAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1; return true;
  }
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(String(reason).slice(0, 100));
    const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code, 0); r.copy(p, 2);
    try { this.s.write(frame(0x8, p)); } catch (_) {}
    this.closed = true;
    setTimeout(() => { try { this.s.destroy(); } catch (_) {} }, 200);
    this.onClose();
  }
  ping() {
    if (this.closed) return;
    if (!this.alive) { this.close(1001, 'ping timeout'); return; }
    this.alive = false;
    try { this.s.write(frame(0x9, Buffer.alloc(0))); } catch (_) {}
  }
  onData(chunk) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
      if (b[0] & 0x70) return this.close(1002, 'rsv');
      if (!masked) return this.close(1002, 'unmasked');
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) return this.close(1009, 'too big');
        len = Number(big); off = 10;
      }
      if (len > MAX_FRAME) return this.close(1009, 'too big');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this.onFrame(fin, op, data);
      if (this.closed) return;
    }
  }
  onFrame(fin, op, data) {
    if (op >= 0x8) {                       // control
      if (!fin || data.length > 125) return this.close(1002, 'bad control');
      if (op === 0x8) { this.close(1000, ''); return; }
      if (op === 0x9) { try { this.s.write(frame(0xA, data)); } catch (_) {} return; }
      if (op === 0xA) { this.alive = true; return; }
      return this.close(1002, 'bad opcode');
    }
    if (op === 0x2) return this.close(1003, 'binary not supported');
    if (op === 0x1) { if (this.fragOp) return this.close(1002, 'frag'); this.fragOp = 1; this.frag = []; this.fragLen = 0; }
    else if (op === 0x0) { if (!this.fragOp) return this.close(1002, 'frag'); }
    else return this.close(1002, 'bad opcode');
    this.frag.push(data); this.fragLen += data.length;
    if (this.fragLen > MAX_FRAME) return this.close(1009, 'too big');
    if (!fin) return;
    const text = Buffer.concat(this.frag).toString('utf8');
    this.fragOp = 0; this.frag = []; this.fragLen = 0;
    let msg; try { msg = JSON.parse(text); } catch (_) { return; }
    if (msg && typeof msg === 'object' && typeof msg.type === 'string') handle(this, msg);
  }
  onClose() {
    if (this._gone) return;
    this._gone = true; this.closed = true;
    clearTimeout(this.authTimer);
    const n = (connsPerIp.get(this.ip) || 1) - 1;
    if (n <= 0) connsPerIp.delete(this.ip); else connsPerIp.set(this.ip, n);
    if (this.authed && clients.get(this.id) === this) {
      leaveRoom(this);
      clients.delete(this.id);
      broadcastPeers();
      log('bye', this.id, this.name);
    }
  }
}

// ---------------------------------------------------------------- lógica
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);

function peersFor(c) {
  const out = [];
  for (const o of clients.values()) if (o !== c) out.push({ id: o.id, name: o.name, busy: !!o.room });
  return out;
}
function broadcastPeers() {
  for (const c of clients.values()) c.send({ type: 'peers', peers: peersFor(c) });
}

function dropInvite(room, id, notify) {
  const t = room.invited.get(id);
  if (t === undefined) return;
  clearTimeout(t); room.invited.delete(id);
  if (notify) { const c = clients.get(id); if (c) c.send({ type: 'invite_cancel', room: room.id }); }
}

function leaveRoom(c) {
  const room = c.room && rooms.get(c.room);
  c.room = null;
  if (!room) return;
  room.members.delete(c.id);
  for (const m of room.members.values()) m.send({ type: 'peer_left', room: room.id, id: c.id });
  if (room.members.size === 0) {
    for (const id of [...room.invited.keys()]) dropInvite(room, id, true);
    rooms.delete(room.id);
  }
  broadcastPeers();
}

function handle(c, m) {
  if (!c.authed) {
    if (m.type !== 'hello') return;
    return authenticate(c, m);
  }
  switch (m.type) {
    case 'ping': return c.send({ type: 'pong' });
    case 'list': return c.send({ type: 'peers', peers: peersFor(c) });
    case 'rename': { c.name = clean(m.name, 40) || c.name; return broadcastPeers(); }

    case 'join': {
      const rid = m.room;
      if (typeof rid !== 'string' || !RE_ROOM.test(rid)) return c.send({ type: 'error', code: 'bad_room' });
      if (c.room && c.room !== rid) leaveRoom(c);
      let room = rooms.get(rid);
      if (!room) { room = { id: rid, video: !!m.video, members: new Map(), invited: new Map() }; rooms.set(rid, room); }
      if (!room.members.has(c.id) && room.members.size >= CFG.maxRoom) return c.send({ type: 'error', code: 'room_full', room: rid });
      const existing = [...room.members.values()].filter((o) => o !== c).map((o) => ({ id: o.id, name: o.name }));
      room.members.set(c.id, c); c.room = rid;
      dropInvite(room, c.id, false);
      c.send({ type: 'joined', room: rid, you: c.id, video: room.video, peers: existing, iceServers: iceServers(c.id) });
      for (const o of room.members.values()) if (o !== c) o.send({ type: 'peer_joined', room: rid, id: c.id, name: c.name });
      return broadcastPeers();
    }
    case 'leave': return leaveRoom(c);

    // Retransmisión punto a punto de cualquier mensaje de ChatLAN (texto, archivos, avatar, escribiendo...).
    // El servidor NO interpreta `data`; solo fija el remitente real (`from`) para que nadie pueda suplantar a otro.
    case 'relay': {
      const ref = typeof m.ref === 'string' ? m.ref.slice(0, 40) : '';
      const fail = (code) => { if (ref) c.send({ type: 'relay_nack', ref, code }); };
      if (typeof m.to !== 'string' || typeof m.data !== 'string' || m.data.length > MAX_RELAY_DATA) return fail('bad_request');
      if (!c.take()) return fail('rate_limited');
      const to = clients.get(m.to);
      if (!to || to === c) return fail('offline');
      if (!to.send({ type: 'relay', from: c.id, data: m.data })) return fail('offline');
      if (ref && m.ack) c.send({ type: 'relay_ack', ref });
      return;
    }

    case 'signal': {
      const room = c.room && rooms.get(c.room);
      if (!room || m.room !== room.id) return;
      const to = room.members.get(m.to);
      if (!to || typeof m.data !== 'string' || m.data.length > 32768) return;
      return to.send({ type: 'signal', room: room.id, from: c.id, data: m.data });
    }

    case 'invite': {
      const room = c.room && rooms.get(c.room);
      if (!room || m.room !== room.id || !Array.isArray(m.to)) return c.send({ type: 'error', code: 'not_in_room' });
      const now = Date.now();
      c.inviteTimes = c.inviteTimes.filter((t) => now - t < 60000);
      if (c.inviteTimes.length >= 20) return c.send({ type: 'error', code: 'rate_limited' });
      c.inviteTimes.push(now);
      const delivered = [], offline = [], busy = [];
      for (const id of m.to.slice(0, CFG.maxRoom)) {
        if (typeof id !== 'string' || id === c.id || room.members.has(id)) continue;
        const t = clients.get(id);
        if (!t) { offline.push(id); continue; }
        if (t.room) { busy.push(id); continue; }
        dropInvite(room, id, false);
        room.invited.set(id, setTimeout(() => dropInvite(room, id, true), CFG.inviteTtlMs));
        t.send({ type: 'invite', room: room.id, from: { id: c.id, name: c.name }, video: !!m.video, members: room.members.size });
        delivered.push(id);
      }
      return c.send({ type: 'invite_result', room: room.id, delivered, offline, busy });
    }
    case 'decline': {
      const inviter = clients.get(m.to);
      const room = rooms.get(m.room);
      if (room) dropInvite(room, c.id, false);
      if (inviter) inviter.send({ type: 'declined', room: clean(m.room, 64), from: c.id, name: c.name, reason: clean(m.reason, 20) });
      return;
    }
    default: return;
  }
}

function authenticate(c, m) {
  const f = authFails.get(c.ip) || { n: 0, first: Date.now(), blockedUntil: 0 };
  const id = m.id;
  if (!keyOk(m.key) || typeof id !== 'string' || !RE_ID.test(id)) {
    if (Date.now() - f.first > 600000) { f.n = 0; f.first = Date.now(); }
    f.n++; if (f.n >= 10) f.blockedUntil = Date.now() + 15 * 60000;
    authFails.set(c.ip, f);
    c.send({ type: 'error', code: 'auth' });
    log('auth fail', c.ip);
    return c.close(4003, 'auth');
  }
  authFails.delete(c.ip);
  clearTimeout(c.authTimer);
  const old = clients.get(id);
  if (old && old !== c) {   // un solo usuario por ID: la sesión nueva sustituye a la anterior (nunca hay dos entradas)
    clients.delete(id); old.authed = false; leaveRoom(old); old.send({ type: 'error', code: 'replaced' }); old.close(4001, 'replaced');
  }
  c.id = id; c.name = clean(m.name, 40) || 'Anonimo'; c.authed = true;
  clients.set(id, c);
  c.send({ type: 'welcome', id, maxRoom: CFG.maxRoom, relay: true, maxRelayData: MAX_RELAY_DATA, peers: peersFor(c) });
  broadcastPeers();
  log('hello', id, c.name, c.ip);
}

// ---------------------------------------------------------------- HTTP / upgrade
function clientIp(req) {
  if (CFG.trustProxy) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xf.length) return xf[xf.length - 1];
  }
  return req.socket.remoteAddress || '?';
}

const handler = (req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ChatLAN call server'); }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
};
const tls = CFG.tlsCert && CFG.tlsKey;
const server = tls
  ? https.createServer({ cert: fs.readFileSync(CFG.tlsCert), key: fs.readFileSync(CFG.tlsKey) }, handler)
  : http.createServer(handler);
server.headersTimeout = 10000; server.requestTimeout = 15000;

server.on('upgrade', (req, socket) => {
  const ip = clientIp(req);
  const f = authFails.get(ip);
  const key = req.headers['sec-websocket-key'];
  const bad = req.url.split('?')[0] !== '/ws' || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket';
  if (bad) { socket.destroy(); return; }
  if ((f && f.blockedUntil > Date.now()) || (connsPerIp.get(ip) || 0) >= CFG.maxConnsPerIp) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  connsPerIp.set(ip, (connsPerIp.get(ip) || 0) + 1);
  new Conn(socket, ip);
});

setInterval(() => { for (const c of clients.values()) c.ping(); }, PING_MS).unref();

if (require.main === module) {
  server.listen(CFG.port, CFG.host, () =>
    log(`ChatLAN call server en ${tls ? 'wss' : 'ws'}://${CFG.host}:${CFG.port}/ws  (sala max ${CFG.maxRoom}, TURN ${CFG.turnUrls.length && CFG.turnSecret ? 'si' : 'no'})`));
}
module.exports = { server, CFG, clients, rooms };
