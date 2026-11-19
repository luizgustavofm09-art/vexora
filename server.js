#!/usr/bin/env node
/*
 * VEXORA: BANGERS — servidor multiplayer (WebSocket + salas)
 *
 * Sem dependências: só precisa do Node.js 16 ou mais novo.
 *   node server.js            → http://localhost:3000
 *   PORT=8080 node server.js  → outra porta
 *
 * O servidor também entrega o index.html, então basta mandar o link
 * http://SEU-IP:3000 para os amigos. Cada sala tem até 16 jogadores
 * (1 anfitrião + 15 amigos).
 *
 * O servidor é um "retransmissor" de salas: ele cuida de salas, convites,
 * anfitrião, chat e repassa as mensagens da partida. As regras do jogo
 * rodam nos clientes (bom para jogar entre amigos, não é à prova de trapaça).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS = 16;            // anfitrião + 15 amigos
const MAX_BOTS = 24;
const MAX_FRAME = 256 * 1024;      // maior mensagem aceita (lista de loot da partida)
const BYTES_PER_SEC = 600 * 1024;  // limite de tráfego por jogador
const MSGS_PER_SEC = 90;           // limite de mensagens por jogador
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MODES = new Set(['br', 'sq', 'dm']);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ------------------------------------------------------------------ */
/* HTTP: entrega o index.html e um /health                             */
/* ------------------------------------------------------------------ */
const INDEX = path.join(__dirname, 'index.html');
const httpServer = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: conns.size }));
    return;
  }
  if (url === '/' || url === '/index.html') {
    fs.readFile(INDEX, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('index.html não encontrado ao lado do server.js');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Não encontrado');
});

/* ------------------------------------------------------------------ */
/* WebSocket (RFC 6455) mínimo                                         */
/* ------------------------------------------------------------------ */
let nextId = 1;
const conns = new Map();   // id -> Conn
const rooms = new Map();   // code -> Room

class Conn {
  constructor(sock) {
    this.id = nextId++;
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.frag = null;          // mensagem fragmentada em andamento
    this.alive = true;
    this.closed = false;
    this.name = 'Jogador';
    this.skin = { c: 0, w: 0, f: 0, p: 0 };
    this.rp = 0;
    this.room = null;
    this.ready = false;
    this.inMatch = false;
    this.joinedAt = Date.now();
    this.tokM = MSGS_PER_SEC;
    this.tokB = BYTES_PER_SEC;
    this.tokT = Date.now();
    this.strikes = 0;
  }

  send(obj) {
    this.sendRaw(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }

  sendRaw(text) {
    if (this.closed) return;
    // não deixa um cliente lento acumular memória no servidor
    if (this.sock.writableLength > 4 * 1024 * 1024) return this.close(1013, 'lento demais');
    this.sock.write(frame(0x1, Buffer.from(text, 'utf8')));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    try {
      const r = Buffer.from(reason, 'utf8').subarray(0, 100);
      const b = Buffer.alloc(2 + r.length);
      b.writeUInt16BE(code, 0);
      r.copy(b, 2);
      this.sock.write(frame(0x8, b));
    } catch (_) { /* socket já morreu */ }
    this.sock.end();
    setTimeout(() => this.sock.destroy(), 500).unref();
  }
}

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

httpServer.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  sock.setNoDelay(true);
  sock.setTimeout(0);

  const c = new Conn(sock);
  conns.set(c.id, c);
  c.send({ t: 'welcome', id: c.id, max: MAX_PLAYERS, maxBots: MAX_BOTS });

  sock.on('data', (chunk) => {
    c.buf = c.buf.length ? Buffer.concat([c.buf, chunk]) : chunk;
    try { pump(c); } catch (e) { c.close(1002, 'protocolo'); }
  });
  sock.on('close', () => onClose(c));
  sock.on('error', () => { /* o 'close' cuida do resto */ });
});

function pump(c) {
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return;
      len = b.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (b.length < 10) return;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME)) return c.close(1009, 'grande demais');
      len = Number(big); off = 10;
    }
    if (len > MAX_FRAME) return c.close(1009, 'grande demais');
    if (!masked) return c.close(1002, 'sem máscara');
    if (b.length < off + 4 + len) return;
    const mask = b.subarray(off, off + 4);
    const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    c.buf = b.subarray(off + 4 + len);

    if (op === 0x8) return c.close(1000, '');
    if (op === 0x9) { c.sock.write(frame(0xA, data)); continue; }       // ping
    if (op === 0xA) { c.alive = true; continue; }                       // pong
    if (op === 0x1 || op === 0x0 || op === 0x2) {
      if (op === 0x2) return c.close(1003, 'só texto');
      if (op === 0x1) c.frag = { parts: [data], size: data.length };
      else {
        if (!c.frag) return c.close(1002, 'fragmento solto');
        c.frag.parts.push(data); c.frag.size += data.length;
        if (c.frag.size > MAX_FRAME) return c.close(1009, 'grande demais');
      }
      if (fin) {
        const text = Buffer.concat(c.frag.parts).toString('utf8');
        c.frag = null;
        onMessage(c, text);
      }
      continue;
    }
    return c.close(1002, 'opcode');
  }
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
const clampInt = (v, lo, hi, d = lo) => {
  v = Math.floor(Number(v));
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
};
const cleanText = (s, max, fallback = '') => {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, max).join('');
  return s || fallback;
};
const cleanSkin = (s) => {
  s = s && typeof s === 'object' ? s : {};
  return { c: clampInt(s.c, 0, 99, 0), w: clampInt(s.w, 0, 99, 0), f: clampInt(s.f, 0, 99, 0), p: clampInt(s.p, 0, 99, 0) };
};

function makeCode() {
  for (let t = 0; t < 200; t++) {
    let code = '';
    for (let i = 0; i < 5; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

const members = (room) => [...conns.values()].filter((c) => c.room === room);

function roomSnapshot(room) {
  const list = members(room).sort((a, b) => a.joinedAt - b.joinedAt || a.id - b.id);
  return {
    t: 'room',
    code: room.code,
    name: room.name,
    hostId: room.hostId,
    simId: room.simId || null,
    mode: room.mode,
    bots: room.bots,
    priv: room.priv,
    state: room.state,
    max: MAX_PLAYERS,
    players: list.map((c) => ({
      id: c.id, name: c.name, skin: c.skin, rp: c.rp,
      ready: c.ready, inMatch: c.inMatch, host: c.id === room.hostId,
    })),
  };
}

function broadcastRoom(room) {
  const snap = JSON.stringify(roomSnapshot(room));
  for (const c of members(room)) c.sendRaw(snap);
}

function sendRoomsList(c) {
  const list = [];
  for (const r of rooms.values()) {
    if (r.priv) continue;
    const m = members(r);
    const host = conns.get(r.hostId);
    list.push({ code: r.code, name: r.name, mode: r.mode, count: m.length, max: MAX_PLAYERS, state: r.state, host: host ? host.name : '?' });
  }
  list.sort((a, b) => (a.state === 'lobby' ? 0 : 1) - (b.state === 'lobby' ? 0 : 1) || b.count - a.count);
  c.send({ t: 'rooms', rooms: list.slice(0, 40) });
}

function leaveRoom(c, why) {
  const room = c.room;
  if (!room) return;
  c.room = null; c.ready = false; c.inMatch = false;
  const rest = members(room);
  if (!rest.length) {
    rooms.delete(room.code);
    log(`sala ${room.code} encerrada`);
    return;
  }
  for (const m of rest) m.send({ t: 'left', id: c.id, name: c.name, why: why || 'left' });
  if (room.hostId === c.id) {
    rest.sort((a, b) => a.joinedAt - b.joinedAt || a.id - b.id);
    room.hostId = rest[0].id;
    rest[0].ready = false;
    for (const m of rest) m.send({ t: 'host', id: room.hostId, name: rest[0].name });
    log(`sala ${room.code}: novo anfitrião ${rest[0].name}`);
  }
  // se ninguém mais estiver em partida, a sala volta para o lobby
  if (room.state === 'playing' && !rest.some((m) => m.inMatch)) resetToLobby(room);
  else { reassignSim(room); broadcastRoom(room); }
}

// Quem roda os bots e a zona da partida ("dono da simulação"). Se ele sair da
// partida, o jogador mais antigo que continua jogando assume.
function reassignSim(room) {
  if (room.state !== 'playing') return false;
  const cur = conns.get(room.simId);
  if (cur && cur.room === room && cur.inMatch) return false;
  const next = members(room).filter((m) => m.inMatch).sort((a, b) => a.joinedAt - b.joinedAt || a.id - b.id)[0];
  room.simId = next ? next.id : null;
  for (const m of members(room)) m.send({ t: 'sim', id: room.simId });
  if (next) log(`sala ${room.code}: ${next.name} assumiu a simulação (bots/zona)`);
  return true;
}

function resetToLobby(room) {
  room.simId = null;
  room.state = 'lobby';
  for (const m of members(room)) { m.inMatch = false; m.ready = false; }
  broadcastRoom(room);
}

function onClose(c) {
  if (c.closed) return;
  c.closed = true;
  leaveRoom(c, 'disconnect');
  conns.delete(c.id);
}

const log = (...a) => console.log(new Date().toLocaleTimeString('pt-BR'), ...a);

/* ------------------------------------------------------------------ */
/* Mensagens                                                           */
/* ------------------------------------------------------------------ */
function allow(c, bytes) {
  const now = Date.now(), dt = (now - c.tokT) / 1000;
  c.tokT = now;
  c.tokM = Math.min(MSGS_PER_SEC * 2, c.tokM + dt * MSGS_PER_SEC);
  c.tokB = Math.min(BYTES_PER_SEC * 2, c.tokB + dt * BYTES_PER_SEC);
  if (c.tokM < 1 || c.tokB < bytes) {
    if (++c.strikes > 400) c.close(1008, 'muitas mensagens');
    return false;
  }
  c.tokM -= 1; c.tokB -= bytes;
  return true;
}

function onMessage(c, text) {
  if (!allow(c, text.length)) return;
  let m;
  try { m = JSON.parse(text); } catch (_) { return; }
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;

  switch (m.t) {
    case 'hello': {
      c.name = cleanText(m.name, 14, 'Jogador');
      c.skin = cleanSkin(m.skin);
      c.rp = clampInt(m.rp, 0, 99999, 0);
      if (c.room) broadcastRoom(c.room);
      return;
    }
    case 'ping':
      return c.send({ t: 'pong', ts: m.ts });

    case 'list':
      return sendRoomsList(c);

    case 'create': {
      if (c.room) leaveRoom(c, 'left');
      const code = makeCode();
      if (!code) return c.send({ t: 'err', m: 'Servidor cheio. Tente de novo em instantes.' });
      const room = {
        code,
        name: cleanText(m.name, 22, 'Sala de ' + c.name),
        hostId: c.id,
        mode: MODES.has(m.mode) ? m.mode : 'br',
        bots: clampInt(m.bots, 0, MAX_BOTS, 0),
        priv: m.priv !== false,
        state: 'lobby',
      };
      rooms.set(code, room);
      c.room = room; c.ready = false; c.inMatch = false; c.joinedAt = Date.now();
      log(`sala ${code} criada por ${c.name}`);
      return broadcastRoom(room);
    }

    case 'join': {
      const code = cleanText(m.code, 8).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const room = rooms.get(code);
      if (!room) return c.send({ t: 'err', m: 'Sala "' + code + '" não existe. Confira o código.', code: 'nf' });
      if (c.room === room) return broadcastRoom(room);
      if (members(room).length >= MAX_PLAYERS) return c.send({ t: 'err', m: 'Sala cheia (' + MAX_PLAYERS + '/' + MAX_PLAYERS + ').', code: 'full' });
      if (c.room) leaveRoom(c, 'left');
      c.room = room; c.ready = false; c.inMatch = false; c.joinedAt = Date.now();
      for (const o of members(room)) if (o !== c) o.send({ t: 'joined', id: c.id, name: c.name });
      log(`${c.name} entrou na sala ${code} (${members(room).length}/${MAX_PLAYERS})`);
      return broadcastRoom(room);
    }

    case 'leave':
      return leaveRoom(c, 'left');

    case 'set': {
      const room = c.room;
      if (!room || room.hostId !== c.id || room.state !== 'lobby') return;
      if (MODES.has(m.mode)) room.mode = m.mode;
      if (m.bots !== undefined) room.bots = clampInt(m.bots, 0, MAX_BOTS, room.bots);
      if (m.priv !== undefined) room.priv = !!m.priv;
      if (m.name !== undefined) room.name = cleanText(m.name, 22, room.name);
      return broadcastRoom(room);
    }

    case 'ready': {
      if (!c.room || c.room.state !== 'lobby') return;
      c.ready = !!m.v;
      return broadcastRoom(c.room);
    }

    case 'kick': {
      const room = c.room;
      if (!room || room.hostId !== c.id) return;
      const t = conns.get(Number(m.id));
      if (!t || t === c || t.room !== room) return;
      t.send({ t: 'kicked' });
      leaveRoom(t, 'kicked');
      return;
    }

    case 'chat': {
      const room = c.room;
      if (!room) return;
      const msg = cleanText(m.m, 140);
      if (!msg) return;
      const out = JSON.stringify({ t: 'chat', id: c.id, name: c.name, m: msg });
      for (const o of members(room)) o.sendRaw(out);
      return;
    }

    case 'start': {
      const room = c.room;
      if (!room || room.hostId !== c.id || room.state !== 'lobby') return;
      const list = members(room).sort((a, b) => a.joinedAt - b.joinedAt || a.id - b.id);
      const mode = MODES.has(m.mode) ? m.mode : room.mode;
      const bots = Array.isArray(m.bots) ? m.bots.slice(0, room.bots) : [];
      if (list.length < 2 && bots.length < 1) {
        return c.send({ t: 'err', m: 'Chame ao menos 1 amigo ou ative bots para iniciar.' });
      }
      room.mode = mode;
      room.state = 'playing';
      room.simId = room.hostId;
      const roster = bots.map((b) => {
        b = b && typeof b === 'object' ? b : {};
        const s = cleanSkin(b);
        return { n: cleanText(b.n, 14, 'Bot'), c: s.c, w: s.w, p: s.p, f: s.f };
      });
      for (const o of list) { o.inMatch = true; o.ready = false; }
      const msg = {
        t: 'start',
        mode,
        map: cleanText(m.map, 12, 'vex'),
        bots: roster,
        hostId: room.hostId,
        players: list.map((o, i) => ({ id: o.id, name: o.name, skin: o.skin, idx: i })),
      };
      const out = JSON.stringify(msg);
      for (const o of list) o.sendRaw(out);
      log(`sala ${room.code}: partida ${mode} iniciada (${list.length} jogadores + ${roster.length} bots)`);
      return broadcastRoom(room);
    }

    // dados rápidos de partida (posição etc.) → todos os outros da partida
    case 's': {
      const room = c.room;
      if (!room || !c.inMatch || room.state !== 'playing' || typeof m.d !== 'object') return;
      const out = '{"t":"s","f":' + c.id + ',"d":' + JSON.stringify(m.d) + '}';
      for (const o of members(room)) if (o !== c && o.inMatch) o.sendRaw(out);
      return;
    }

    // eventos de partida (tiro, dano, morte, loot…) → todos, um jogador ou o anfitrião
    case 'ev': {
      const room = c.room;
      if (!room || !c.inMatch || room.state !== 'playing' || typeof m.d !== 'object') return;
      const out = '{"t":"ev","f":' + c.id + ',"d":' + JSON.stringify(m.d) + '}';
      if (m.to === 'host' || m.to === 'sim') {
        const h = conns.get(room.simId || room.hostId);
        if (h && h !== c && h.room === room) h.sendRaw(out);
      } else if (typeof m.to === 'number') {
        const o = conns.get(m.to);
        if (o && o !== c && o.room === room && o.inMatch) o.sendRaw(out);
      } else {
        for (const o of members(room)) if (o !== c && o.inMatch) o.sendRaw(out);
      }
      return;
    }

    case 'back': {
      const room = c.room;
      if (!room) return;
      c.inMatch = false; c.ready = false;
      if (room.state === 'playing' && !members(room).some((o) => o.inMatch)) resetToLobby(room);
      else { reassignSim(room); broadcastRoom(room); }
      return;
    }

    // o anfitrião pode encerrar a partida para todo mundo voltar à sala
    case 'endmatch': {
      const room = c.room;
      if (!room || room.hostId !== c.id || room.state !== 'playing') return;
      for (const o of members(room)) if (o.inMatch) o.send({ t: 'ended' });
      resetToLobby(room);
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Batimento: derruba conexões mortas                                  */
/* ------------------------------------------------------------------ */
setInterval(() => {
  for (const c of conns.values()) {
    if (!c.alive) { c.sock.destroy(); continue; }
    c.alive = false;
    try { c.sock.write(frame(0x9, Buffer.alloc(0))); } catch (_) { /* ignora */ }
  }
}, 20000).unref();

/* ------------------------------------------------------------------ */
httpServer.listen(PORT, HOST, () => {
  console.log('\n  VEXORA: BANGERS — servidor multiplayer no ar\n');
  console.log('  Neste computador : http://localhost:' + PORT);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) console.log('  Mesma rede (Wi-Fi): http://' + n.address + ':' + PORT);
    }
  }
  console.log('  Salas: até ' + MAX_PLAYERS + ' jogadores (anfitrião + ' + (MAX_PLAYERS - 1) + ' amigos)\n');
});

module.exports = { httpServer, rooms, conns };
