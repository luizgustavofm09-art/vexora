/* ======================================================================
 * VEXORA: BANGERS — módulo de AMIGOS (servidor)
 * ====================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function attachFriends(wss, opts = {}) {
  const FILE = opts.file || path.join(__dirname, 'friends-data.json');
  const MAX_FRIENDS = 100;
  const REQ_COOLDOWN = 8000;
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  /* ----------------------------------------------------------- dados */
  let db = { users: {} };
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (!db.users) db = { users: {} }; } catch (_) {}
  let saveT = null;
  const save = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => { fs.writeFile(FILE, JSON.stringify(db), () => {}); }, 400);
  };
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

  const online = new Map();
  const live = new Map();
  const pending = new Map();
  const lastAsk = new Map();

  const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').slice(0, n);
  const validUid = (u) => typeof u === 'string' && /^[A-Z0-9]{6,12}$/.test(u);
  const tx = (ws, o) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (_) {} };
  const toUid = (uid, o) => tx(online.get(uid), o);

  const pub = (uid) => {
    const u = db.users[uid]; if (!u) return null;
    const lv = live.get(uid) || {};
    const on = online.has(uid);
    return {
      uid, name: u.name, rp: u.rp | 0, lv: u.lv | 0, on,
      state: on ? (lv.state || 'lobby') : 'off',
      room: on && lv.room ? lv.room : null,
    };
  };

  function stateFor(uid) {
    const u = db.users[uid];
    return {
      t: 'fr_state',
      me: { uid, name: u.name },
      friends: u.friends.map(pub).filter(Boolean),
      reqIn: u.reqIn.map(pub).filter(Boolean),
      reqOut: u.reqOut.map(pub).filter(Boolean),
    };
  }
  const pushState = (uid) => { if (online.has(uid) && db.users[uid]) toUid(uid, stateFor(uid)); };
  const presenceToFriends = (uid) => {
    const u = db.users[uid]; if (!u) return;
    const p = pub(uid);
    for (const f of u.friends) toUid(f, { t: 'fr_presence', ...p });
  };
  const err = (ws, m) => tx(ws, { t: 'fr_err', m });

  const newUid = () => {
    for (;;) {
      let s = ''; const b = crypto.randomBytes(8);
      for (let i = 0; i < 8; i++) s += ALPHA[b[i] % ALPHA.length];
      if (!db.users[s]) return s;
    }
  };

  /* -------------------------------------------------------- mensagens */
  const H = {};

  H.fr_hello = (ws, m) => {
    let uid = m.uid; const tok = String(m.tok || '');
    if (tok.length < 16) return err(ws, 'Identidade inválida.');
    let u = validUid(uid) ? db.users[uid] : null;
    if (u) {
      if (u.tok !== sha(tok)) return err(ws, 'Esse ID já pertence a outro dispositivo.');
    } else {
      if (!validUid(uid) || db.users[uid]) uid = newUid();
      u = db.users[uid] = { tok: sha(tok), name: 'Jogador', rp: 0, lv: 1, friends: [], reqIn: [], reqOut: [], created: Date.now() };
    }
    const old = online.get(uid);
    if (old && old !== ws) { try { old.vxUid = null; } catch (_) {} }
    ws.vxUid = uid; online.set(uid, ws);
    u.name = clean(m.name, 14) || u.name; u.rp = Math.max(0, m.rp | 0); u.lv = Math.max(1, m.lv | 0);
    live.set(uid, { state: 'lobby', room: null });
    save();
    tx(ws, { t: 'fr_ready', uid });
    pushState(uid);
    presenceToFriends(uid);
  };

  H.fr_status = (ws, m, uid) => {
    const u = db.users[uid];
    if (m.name) u.name = clean(m.name, 14) || u.name;
    if (m.rp != null) u.rp = Math.max(0, m.rp | 0);
    if (m.lv != null) u.lv = Math.max(1, m.lv | 0);
    const state = ['lobby', 'room', 'match'].includes(m.state) ? m.state : 'lobby';
    let room = null;
    if (m.room && typeof m.room === 'object') {
      room = {
        name: clean(m.room.name, 22), mode: clean(m.room.mode, 4),
        n: Math.max(0, m.room.n | 0), max: Math.max(1, m.room.max | 0), host: !!m.room.host,
      };
    }
    live.set(uid, { state, room });
    if (!room || !room.host) for (const k of [...pending.keys()]) if (k.startsWith(uid + '>')) pending.delete(k);
    presenceToFriends(uid);
  };

  H.fr_add = (ws, m, uid) => {
    const target = String(m.uid || '').trim().toUpperCase();
    const me = db.users[uid], t = db.users[target];
    if (!validUid(target) || !t) return err(ws, 'ID não encontrado. Confira os caracteres.');
    if (target === uid) return err(ws, 'Esse é o seu próprio ID.');
    if (me.friends.includes(target)) return err(ws, 'Vocês já são amigos.');
    if (me.friends.length >= MAX_FRIENDS) return err(ws, 'Sua lista de amigos está cheia.');
    if (me.reqIn.includes(target)) return H.fr_accept(ws, { uid: target }, uid);
    if (me.reqOut.includes(target)) return err(ws, 'Pedido já enviado. Aguarde a resposta.');
    if (t.reqIn.length >= 50) return err(ws, 'Esse jogador tem pedidos demais pendentes.');
    me.reqOut.push(target); t.reqIn.push(uid);
    save();
    tx(ws, { t: 'fr_ok', m: 'Pedido de amizade enviado para ' + t.name + '!' });
    pushState(uid); pushState(target);
    toUid(target, { t: 'fr_note', k: 'req', from: pub(uid) });
  };

  H.fr_accept = (ws, m, uid) => {
    const f = String(m.uid || ''); const me = db.users[uid], o = db.users[f];
    if (!o || !me.reqIn.includes(f)) return err(ws, 'Pedido não encontrado.');
    me.reqIn = me.reqIn.filter((x) => x !== f); o.reqOut = o.reqOut.filter((x) => x !== uid);
    if (!me.friends.includes(f)) me.friends.push(f);
    if (!o.friends.includes(uid)) o.friends.push(uid);
    save();
    pushState(uid); pushState(f);
    toUid(f, { t: 'fr_note', k: 'accepted', from: pub(uid) });
  };

  H.fr_decline = (ws, m, uid) => {
    const f = String(m.uid || ''); const me = db.users[uid], o = db.users[f];
    me.reqIn = me.reqIn.filter((x) => x !== f);
    if (o) o.reqOut = o.reqOut.filter((x) => x !== uid);
    save(); pushState(uid); pushState(f);
  };

  H.fr_cancel = (ws, m, uid) => {
    const f = String(m.uid || ''); const me = db.users[uid], o = db.users[f];
    me.reqOut = me.reqOut.filter((x) => x !== f);
    if (o) o.reqIn = o.reqIn.filter((x) => x !== uid);
    save(); pushState(uid); pushState(f);
  };

  H.fr_remove = (ws, m, uid) => {
    const f = String(m.uid || ''); const me = db.users[uid], o = db.users[f];
    me.friends = me.friends.filter((x) => x !== f);
    if (o) o.friends = o.friends.filter((x) => x !== uid);
    pending.delete(uid + '>' + f); pending.delete(f + '>' + uid);
    save(); pushState(uid); pushState(f);
  };

  H.fr_join = (ws, m, uid) => {
    const host = String(m.to || ''); const me = db.users[uid];
    if (!me.friends.includes(host)) return err(ws, 'Só é possível pedir entrada na sala de um amigo.');
    const lv = live.get(host);
    if (!online.has(host) || !lv || !lv.room || !lv.room.host) return err(ws, 'Esse amigo não está com uma sala aberta agora.');
    if (lv.state === 'match') return err(ws, 'A partida desse amigo já começou.');
    if (lv.room.n >= lv.room.max) return err(ws, 'A sala está cheia.');
    const key = host + '>' + uid, ask = uid + '>' + host, now = Date.now();
    if (pending.has(key)) return err(ws, 'Você já pediu para entrar. Aguarde a confirmação do criador.');
    if (now - (lastAsk.get(ask) || 0) < REQ_COOLDOWN) return err(ws, 'Aguarde alguns segundos antes de pedir de novo.');
    lastAsk.set(ask, now);
    pending.set(key, { ts: now });
    tx(ws, { t: 'fr_joinwait', to: host, name: db.users[host].name });
    toUid(host, { t: 'fr_joinreq', from: pub(uid) });
  };

  H.fr_joinans = (ws, m, uid) => {
    const guest = String(m.to || ''); const key = uid + '>' + guest;
    if (!pending.has(key)) return;
    pending.delete(key);
    const lv = live.get(uid);
    const ok = !!m.ok && lv && lv.room && lv.room.host && typeof m.code === 'string' && /^[A-Z0-9]{3,10}$/.test(m.code);
    toUid(guest, { t: 'fr_joinres', from: pub(uid), ok: !!ok, code: ok ? m.code : undefined, why: m.ok && !ok ? 'A sala não está mais disponível.' : undefined });
  };

  H.fr_invite = (ws, m, uid) => {
    const to = String(m.to || ''); const me = db.users[uid];
    if (!me.friends.includes(to)) return err(ws, 'Só é possível convidar amigos.');
    if (!online.has(to)) return err(ws, 'Esse amigo está offline.');
    const lv = live.get(uid);
    if (!lv || !lv.room || !lv.room.host) return err(ws, 'Crie uma sala primeiro.');
    if (typeof m.code !== 'string' || !/^[A-Z0-9]{3,10}$/.test(m.code)) return err(ws, 'Sala inválida.');
    toUid(to, { t: 'fr_invited', from: pub(uid), code: m.code, room: { name: lv.room.name, mode: lv.room.mode } });
    tx(ws, { t: 'fr_ok', m: 'Convite enviado para ' + db.users[to].name + '.' });
  };

  /* ------------------------------------------------------ plug no wss */
  const isFr = (raw) => {
    try {
      const s = typeof raw === 'string' ? raw : raw.toString();
      if (s.charCodeAt(0) !== 123) return null;
      const m = JSON.parse(s);
      return m && typeof m.t === 'string' && m.t.startsWith('fr_') ? m : null;
    } catch (_) { return null; }
  };

  wss.prependListener('connection', (ws) => {
    const origOn = ws.on.bind(ws);
    ws.on = function (ev, fn) {
      if (ev === 'message') return origOn('message', (data, ...rest) => { if (!isFr(data)) fn(data, ...rest); });
      return origOn(ev, fn);
    };
    origOn('message', (data) => {
      const m = isFr(data); if (!m) return;
      if (m.t === 'fr_hello') return H.fr_hello(ws, m);
      const uid = ws.vxUid;
      if (!uid || !db.users[uid]) return err(ws, 'Conecte-se primeiro.');
      const h = H[m.t]; if (h) { try { h(ws, m, uid); } catch (e) { err(ws, 'Erro interno.'); } }
    });
    origOn('close', () => {
      const uid = ws.vxUid; if (!uid || online.get(uid) !== ws) return;
      online.delete(uid); live.delete(uid);
      for (const k of [...pending.keys()]) if (k.startsWith(uid + '>') || k.endsWith('>' + uid)) pending.delete(k);
      presenceToFriends(uid);
    });
  });

  return { online, db };
};
