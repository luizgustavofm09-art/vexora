#!/usr/bin/env node
/*
 * VEXORA: BANGERS — servidor multiplayer (WebSocket + salas + amigos)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS = 16;
const MAX_BOTS = 24;
const MAX_FRAME = 256 * 1024;
const BYTES_PER_SEC = 600 * 1024;
const MSGS_PER_SEC = 90;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MODES = new Set(['br', 'sq', 'dm']);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ------------------------------------------------------------------ */
/* HTTP: entrega arquivos estáticos (index.html, mp.js, imagens, etc.) */
/* ------------------------------------------------------------------ */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
};

const httpServer = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: conns.size }));
    return;
  }

  const safePath = url === '/' ? '/index.html' : url;
  const filePath = path.join(__dirname, path.normalize(safePath).replace(/^(\.\.[\/\\])+/, ''));

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Acesso negado');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Arquivo não encontrado');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

/* ------------------------------------------------------------------ */
/* WebSocket (RFC 6455) 100% compatível com friends-server.js          */
/* ------------------------------------------------------------------ */
let nextId = 1;
const conns = new Map();   // id -> Conn
const rooms = new Map();   // code -> Room

class Conn extends EventEmitter {
  constructor(sock) {
    super();
    this.id = nextId++;
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.alive = true;
    this.closed = false;
    this.readyState = 1; // 1 = OPEN (exigido pelo friends-server.js)
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
    if (this.closed || this.readyState !== 1) return;
    if (this.sock.writableLength > 4 * 1024 * 1024) return this.close(1013, 'lento demais');
    this.sock.write(frame(0x1, Buffer.from(text, 'utf8')));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.readyState = 3; // 3 = CLOSED
    try {
      const r = Buffer.from(reason, 'utf8').subarray(0, 100);
      const b = Buffer.alloc(2 + r.length);
      b.writeUInt16BE(code, 0);
      r.copy(b, 2);
      this.sock.write(frame(0x8, b));
    } catch (_) {}
    this.sock.end();
    setTimeout(() => this.sock.destroy(), 500).unref();
  }
}

// Instância real de EventEmitter (tem prependListener, on, emit, clients)
const wss = new EventEmitter();
wss.clients = new Set();

// Conecta o módulo oficial de amigos
try {
  require('./friends-server')(wss);
  console.log('[OK] Módulo friends-server.js conectado com sucesso!');
} catch (err) {
  console.error('[ERRO] Falha ao carregar friends-server.js:', err);
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
  wss.clients.add(c);

  // Liga o handler do jogo ao evento 'message' do Conn (permite o friends-server interceptar 'fr_*')
  c.on('message', (text) => onMessage(c, text));
  c.on('close', () => onClose(c));

  // Dispara 'connection' para o friends-server.js configurar os ouvintes
  wss.emit('connection', c, req);

  c.send({ t: 'welcome', id: c.id, max: MAX_PLAYERS, maxBots: MAX_BOTS });

  sock.on('data', (chunk) => {
    c.buf = c.buf.length ? Buffer.concat([c.buf, chunk]) : chunk;
    try { pump(c); } catch (e) { c.close(1002, 'protocolo'); }
  });
  sock.on('close', () => c.emit('close'));
  sock.on('error', () => {});
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
    if (op === 0x9) { c.sock.write(frame(0xA, data)); continue; }
    if (op === 0xA) { c.alive = true; continue; }
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
        c.frag
