/* ======================================================================
 * VEXORA: BANGERS — camada MULTIPLAYER (cliente)
 * Envolve as funções do jogo (hurt, bot, startMatch, spawnLoot…) sem
 * reescrevê-las. Offline tudo continua igual: os ganchos só agem quando
 * MP.match é verdadeiro.
 *
 * Modelo: cada cliente manda no PRÓPRIO jogador; o "simulador" (anfitrião,
 * ou quem herdar) roda bots e zona e transmite. Dano: quem atira calcula o
 * acerto e avisa o dono do alvo, que aplica e anuncia a morte.
 * ====================================================================== */
(() => {
'use strict';

const $q = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const PHN = ['plane', 'fall', 'chute', 'ground'];
const PHC = { plane: 0, fall: 1, chute: 2, ground: 3 };
const PAL = [0xffc61a, 0xff5a5a, 0x5aff8a, 0xff8a2a, 0xc05aff, 0x2affd8, 0xff5ad0, 0x9aff2a, 0x5a8aff, 0xffe85a, 0xff2a6a, 0x2a9aff];

const MP = {
  ws: null, connected: false, id: 0, room: null, rooms: [], max: 16, maxBots: 24,
  url: '', err: '', chat: [], open: false,
  match: false, ready: false, isSim: false, simId: 0,
  byNid: new Map(), lootMap: new Map(), pend: [],
  lastS: 0, lastB: 0, lastZ: 0, lc: 0, hitq: new Map(), shooter: null, trb: null,
  applying: false, initLoot: false, ping: 0, typing: false,
};
window.VXMP = MP; // útil para depurar no console

/* ---------------------------------------------------------------- rede */
function defaultURL() {
  if (location.protocol === 'http:' || location.protocol === 'https:') return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  try { return localStorage.getItem('vxmp_url') || 'ws://localhost:3000'; } catch (_) { return 'ws://localhost:3000'; }
}
const needsUrlField = () => !(location.protocol === 'http:' || location.protocol === 'https:');

function send(o) { if (MP.ws && MP.ws.readyState === 1) MP.ws.send(JSON.stringify(o)); }
const evAll = (d) => send({ t: 'ev', d });
const evTo = (to, d) => send({ t: 'ev', to, d });

function skinNow() { return { c: SV.eq.c | 0, w: SV.eq.w | 0, f: SV.eq.f | 0, p: SV.eq.p | 0 }; }
function sendHello() { send({ t: 'hello', name: SV.nick || 'Jogador', skin: skinNow(), rp: SV.rp | 0 }); }

function connect() {
  if (MP.ws && (MP.ws.readyState === 0 || MP.ws.readyState === 1)) return;
  MP.err = '';
  MP.url = MP.url || defaultURL();
  let ws;
  try { ws = new WebSocket(MP.url); } catch (e) { MP.err = 'Endereço inválido.'; render(); return; }
  MP.ws = ws;
  render();
  ws.onopen = () => { MP.connected = true; MP.err = ''; sendHello(); send({ t: 'list' }); render(); };
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } onMsg(m); };
  ws.onerror = () => { MP.err = 'Não consegui conectar em ' + MP.url + '. O servidor está rodando? (node server.js)'; };
  ws.onclose = () => {
    const was = MP.connected;
    MP.connected = false; MP.room = null; MP.ws = null;
    if (MP.match) { takeSim(true); toast('📡 Conexão perdida — seguindo offline'); }
    if (was && !MP.err) MP.err = 'Conexão encerrada.';
    render();
  };
}

function disconnect() { if (MP.ws) { try { MP.ws.close(); } catch (_) {} } }

setInterval(() => { if (MP.connected) send({ t: 'ping', ts: Date.now() }); }, 4000);
setInterval(() => { if (MP.open && MP.connected && !MP.room) send({ t: 'list' }); }, 4000);

function onMsg(m) {
  switch (m.t) {
    case 'welcome': MP.id = m.id; MP.max = m.max || 16; MP.maxBots = m.maxBots || 24; return;
    case 'pong': MP.ping = Date.now() - m.ts; { const e = $q('#mpping'); if (e) e.textContent = MP.ping + ' ms'; } return;
    case 'rooms': MP.rooms = m.rooms || []; render(); return;
    case 'err': MP.err = m.m; if (!MP.open) toast('⚠ ' + esc(m.m)); render(); return;
    case 'room': onRoom(m); return;
    case 'joined': sysChat('🟢 ' + m.name + ' entrou na sala'); return;
    case 'left': sysChat('🔴 ' + m.name + (m.why === 'kicked' ? ' foi expulso' : ' saiu')); return;
    case 'host': sysChat('👑 ' + m.name + ' agora é o anfitrião'); return;
    case 'kicked': MP.room = null; MP.err = 'Você foi expulso da sala.'; render(); return;
    case 'chat': addChat(m.name, m.m, m.id); return;
    case 'sim': MP.simId = m.id; if (MP.match && m.id === MP.id && !MP.isSim) takeSim(false); return;
    case 'ended': if (MP.match && st === 'play') finish(0, 'Partida encerrada pelo anfitrião'); return;
    case 'start': onStart(m); return;
    case 's': case 'ev':
      if (!MP.match) return;
      if (!MP.ready) { MP.pend.push(m); return; }
      m.t === 's' ? onState(m) : onEvent(m);
      return;
  }
}

function onRoom(m) {
  MP.room = m; MP.err = '';
  if (MP.match && MP.ready) {
    for (const p of m.players) {
      if (p.id === MP.id) continue;
      const e = MP.byNid.get(p.id);
      if (e && !p.inMatch) netGone(e);
    }
  }
  render();
}

/* ------------------------------------------------------- chat / avisos */
function addChat(name, text, id) {
  MP.chat.push({ n: name, m: text, me: id === MP.id });
  if (MP.chat.length > 60) MP.chat.shift();
  const l = $q('#mpchatlog'); if (l) { renderChatLog(); }
  if (MP.match) pushMatchChat(name, text);
}
function sysChat(text) {
  MP.chat.push({ s: 1, m: text });
  if (MP.chat.length > 60) MP.chat.shift();
  renderChatLog();
  if (MP.match) pushMatchChat('', text);
}

/* ================================================================ UI */
const css = document.createElement('style');
css.textContent = `
#mpx{position:fixed;inset:0;z-index:26;display:none;align-items:center;justify-content:center;background:rgba(5,3,20,.82);backdrop-filter:blur(6px);font-family:'Trebuchet MS','Segoe UI',system-ui,sans-serif;color:#fff;user-select:text;-webkit-user-select:text}
#mpx.on{display:flex}
#mpx .mpbox{width:min(980px,96vw);max-height:94vh;overflow:auto;background:linear-gradient(#1c0f4a,#120a33);border:4px solid #14082e;border-radius:22px;padding:16px 18px 18px;box-shadow:0 8px 0 #14082e,0 0 0 3px #ffd21f88,0 0 50px #7a3cff66;animation:pop .35s both}
#mpx .mphd{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
#mpx h2{margin:0;font-style:italic;color:#ffd21f;font-size:26px;text-shadow:0 3px 0 #14082e;flex:1}
#mpx h3{margin:0 0 8px;font-size:14px;letter-spacing:1.5px;color:#cdbfff}
.mppill{background:#ffffff1f;border:2px solid #fff4;border-radius:20px;padding:4px 12px;font-weight:900;font-size:13px}
.mppill.ok{border-color:#3ad45a;color:#9dffb0}.mppill.bad{border-color:#ff2e4d;color:#ff8296}
#mpx .mpx{font:900 16px inherit;color:#fff;background:#ff2e4d;border:0;border-radius:10px;padding:8px 14px;cursor:pointer}
#mpx .mpgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:760px){#mpx .mpgrid{grid-template-columns:1fr}}
#mpx .sec{background:#ffffff0d;border:1px solid #ffffff22;border-radius:14px;padding:12px;margin-bottom:12px}
#mpx label{display:block;font-weight:900;font-size:11px;letter-spacing:1.4px;margin:8px 0 4px;color:#cdbfff}
#mpx input[type=text],#mpx input[type=number],#mpx select{width:100%;font:700 15px 'Trebuchet MS',sans-serif;color:#fff;background:#0b0618;border:3px solid #5a3cc0;border-radius:10px;padding:9px 12px;outline:0}
#mpx input:focus,#mpx select:focus{border-color:#ffd21f}
#mpx .code{letter-spacing:6px;text-transform:uppercase;text-align:center;font-size:22px!important}
#mpx .btn2{font:900 16px/1 'Trebuchet MS',sans-serif;font-style:italic;letter-spacing:1px;color:#fff;padding:12px 18px;border:3px solid #14082e;border-radius:14px;background:linear-gradient(#8a4dff,#4a1fb8);box-shadow:0 5px 0 #14082e;cursor:pointer;margin:8px 8px 0 0}
#mpx .btn2:hover{filter:brightness(1.12)}#mpx .btn2:active{transform:translateY(4px);box-shadow:0 1px 0 #14082e}
#mpx .btn2.go{background:linear-gradient(#ffe45c,#ffb400);color:#4a2a00}
#mpx .btn2.red{background:linear-gradient(#ff5a5a,#e0143a)}
#mpx .btn2.grn{background:linear-gradient(#5aff8a,#1fbf3d);color:#06260f}
#mpx .btn2:disabled{filter:grayscale(.8);opacity:.55;cursor:default;transform:none}
#mpx .rl{display:flex;align-items:center;gap:10px;background:#ffffff12;border:1px solid #ffffff22;border-radius:10px;padding:8px 10px;margin-bottom:6px;font-size:13px;font-weight:800}
#mpx .rl small{opacity:.7;font-weight:600}#mpx .rl .sp{flex:1}
#mpx .pls{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}
#mpx .pc{display:flex;align-items:center;gap:8px;background:#ffffff12;border:2px solid #ffffff22;border-radius:12px;padding:8px 10px;font-weight:900;font-size:13px}
#mpx .pc.me{border-color:#ffd21f}#mpx .pc.rd{border-color:#3ad45a}
#mpx .pc .av{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#ffd21f,#ff7a18);font-size:16px}
#mpx .pc .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#mpx .pc small{opacity:.8}#mpx .kk{font-size:11px;padding:3px 7px;border-radius:7px;border:0;background:#ff2e4d;color:#fff;font-weight:900;cursor:pointer}
#mpx .big{font-size:38px;font-weight:900;letter-spacing:8px;color:#ffd21f;text-shadow:0 3px 0 #14082e}
#mpx .modes{display:flex;gap:6px;flex-wrap:wrap}
#mpx .mo2{flex:1;min-width:120px;text-align:center;padding:9px 6px;border:3px solid #14082e;border-radius:12px;background:linear-gradient(#8a4dff,#4a1fb8);font-weight:900;font-size:13px;cursor:pointer}
#mpx .mo2.on{background:linear-gradient(#ffe45c,#ff9a1a);color:#14082e}#mpx .mo2.dis{cursor:default;opacity:.85}
#mpx .mo2 small{display:block;font-weight:600;font-size:10px}
#mpchatlog{height:130px;overflow:auto;background:#0b0618;border:2px solid #5a3cc0;border-radius:10px;padding:8px;font-size:13px;margin-bottom:6px}
#mpchatlog div{margin-bottom:2px}#mpchatlog .s{opacity:.7;font-style:italic}#mpchatlog b{color:#ffd21f}
#mpx .err{min-height:18px;color:#ff8296;font-weight:700;font-size:13px;margin:4px 0}
#mpx .mut{font-size:12px;opacity:.75}
#mpx .chk{display:flex;align-items:center;gap:8px;font-weight:800;font-size:13px;margin-top:8px}
#mpx .chk input{width:18px;height:18px}
#mpleave{position:fixed;left:14px;top:218px;z-index:6;display:none;font:900 12px 'Trebuchet MS',sans-serif;color:#fff;background:#14082ecc;border:3px solid #14082e;border-radius:12px;padding:6px 12px;cursor:pointer;box-shadow:0 0 0 2px #ffd21f66}
#mpfeed{position:fixed;left:14px;bottom:190px;z-index:6;display:none;width:min(320px,60vw);pointer-events:none;font:700 13px 'Trebuchet MS',sans-serif;text-shadow:0 2px 0 #000,0 0 5px #000}
#mpfeed div{margin-top:2px;background:#14082ecc;border-radius:8px;padding:3px 8px;transition:opacity .5s}
#mpfeed b{color:#ffd21f}
#mpchatin{position:fixed;left:14px;bottom:160px;z-index:7;display:none;width:min(320px,60vw);font:700 14px 'Trebuchet MS',sans-serif;color:#fff;background:#0b0618;border:3px solid #ffd21f;border-radius:10px;padding:8px 10px;outline:0;user-select:text;-webkit-user-select:text}
`;
document.head.appendChild(css);

const panel = document.createElement('div');
panel.id = 'mpx';
panel.innerHTML = '<div class="mpbox"><div class="mphd"><h2>👥 MULTIPLAYER</h2><span class="mppill" id="mpst"></span><span class="mppill" id="mpping"></span><button class="mpx" data-a="close">✕ FECHAR</button></div><div id="mpbody"></div></div>';
document.body.appendChild(panel);

const btnLeave = document.createElement('button'); btnLeave.id = 'mpleave'; btnLeave.textContent = '⬅ SAIR DA PARTIDA'; document.body.appendChild(btnLeave);
const matchFeed = document.createElement('div'); matchFeed.id = 'mpfeed'; document.body.appendChild(matchFeed);
const chatIn = document.createElement('input'); chatIn.id = 'mpchatin'; chatIn.type = 'text'; chatIn.maxLength = 140; chatIn.placeholder = 'Mensagem (Enter envia, Esc cancela)'; document.body.appendChild(chatIn);

function pushMatchChat(name, text) {
  const d = document.createElement('div');
  d.innerHTML = (name ? '<b>' + esc(name) + ':</b> ' : '') + esc(text);
  matchFeed.appendChild(d);
  while (matchFeed.children.length > 6) matchFeed.removeChild(matchFeed.firstChild);
  setTimeout(() => { d.style.opacity = 0; setTimeout(() => d.remove(), 600); }, 9000);
}

function renderChatLog() {
  const l = $q('#mpchatlog'); if (!l) return;
  l.innerHTML = MP.chat.map((c) => c.s ? '<div class="s">' + esc(c.m) + '</div>' : '<div><b>' + esc(c.n) + ':</b> ' + esc(c.m) + '</div>').join('');
  l.scrollTop = l.scrollHeight;
}

function openPanel() {
  MP.open = true; panel.classList.add('on');
  if (!MP.connected) connect();
  else { sendHello(); send({ t: 'list' }); }
  render();
}
function closePanel() { MP.open = false; panel.classList.remove('on'); }

const MODEK = ['br', 'sq', 'dm'];
const modeName = (k) => (MODES[k] ? MODES[k].ic + ' ' + MODES[k].n : k);

function viewConnect() {
  return `<div class="sec"><h3>SERVIDOR</h3>
    ${needsUrlField() ? `<label>ENDEREÇO DO SERVIDOR</label><input type="text" id="mp-url" value="${esc(MP.url || defaultURL())}" placeholder="ws://192.168.0.10:3000">` : `<div class="mut">${esc(MP.url || defaultURL())}</div>`}
    <div class="err">${esc(MP.err)}</div>
    <button class="btn2 go" data-a="reconnect">${MP.ws ? 'CONECTANDO…' : '🔌 CONECTAR'}</button>
    <p class="mut">Para jogar com amigos, rode <b>node server.js</b> em um computador e todos abram o endereço que ele mostrar (http://IP:3000).</p></div>`;
}

function viewHome() {
  const nick = esc(SV.nick || 'Jogador');
  const list = MP.rooms.length ? MP.rooms.map((r) => `<div class="rl"><span>${esc(modeName(r.mode))}</span><b>${esc(r.name)}</b><small>por ${esc(r.host)}</small><span class="sp"></span><span>${r.count}/${r.max}</span><small>${r.state === 'lobby' ? 'na sala' : 'em jogo'}</small><button class="kk" style="background:#3ad45a;color:#06260f" data-a="joinpub" data-c="${esc(r.code)}">ENTRAR</button></div>`).join('')
    : '<p class="mut">Nenhuma sala pública agora. Crie a sua!</p>';
  return `<div class="mpgrid">
    <div><div class="sec"><h3>➕ CRIAR SALA</h3>
      <label>NOME DA SALA</label><input type="text" id="mp-cname" maxlength="22" value="Sala de ${nick}">
      <label>MODO</label><select id="mp-cmode">${MODEK.map((k) => `<option value="${k}">${esc(modeName(k))}</option>`).join('')}</select>
      <label>BOTS (0–${MP.maxBots})</label><input type="number" id="mp-cbots" min="0" max="${MP.maxBots}" value="0">
      <label class="chk"><input type="checkbox" id="mp-cpriv" checked> Sala privada (só entra com o código)</label>
      <button class="btn2 go" data-a="create">CRIAR SALA</button></div>
      <div class="sec"><h3>🔑 ENTRAR COM CÓDIGO</h3>
      <input type="text" id="mp-code" class="code" maxlength="8" placeholder="ABCDE">
      <button class="btn2" data-a="join">ENTRAR</button></div></div>
    <div class="sec"><h3>🌐 SALAS PÚBLICAS <button class="kk" data-a="refresh" style="float:right;background:#4a1fb8">↻</button></h3>${list}</div>
  </div><div class="err">${esc(MP.err)}</div>
  <p class="mut">Você aparece como <b>${nick}</b> (mude o nick tocando no seu nome no lobby). Cada sala aceita até ${MP.max} jogadores (você + ${MP.max - 1} amigos).</p>`;
}

function viewRoom() {
  const r = MP.room, host = r.hostId === MP.id, me = r.players.find((p) => p.id === MP.id) || {};
  const link = location.protocol.startsWith('http') ? location.origin + '/?sala=' + r.code : '';
  const pls = r.players.map((p) => `<div class="pc${p.id === MP.id ? ' me' : ''}${p.ready ? ' rd' : ''}"><div class="av">${p.host ? '👑' : '🧑'}</div><div class="nm">${esc(p.name)}${p.id === MP.id ? ' <small>(você)</small>' : ''}</div><small>${p.inMatch ? '🎮 em jogo' : p.host ? 'anfitrião' : p.ready ? '✔ pronto' : '…'}</small>${host && p.id !== MP.id ? `<button class="kk" data-a="kick" data-id="${p.id}">EXPULSAR</button>` : ''}</div>`).join('');
  const modes = MODEK.map((k) => `<div class="mo2${r.mode === k ? ' on' : ''}${host ? '' : ' dis'}" ${host ? `data-a="mode" data-m="${k}"` : ''}>${esc(modeName(k))}<small>${esc(MODES[k] ? MODES[k].d : '')}</small></div>`).join('');
  const playing = r.state === 'playing';
  const canStart = host && !playing && (r.players.length >= 2 || r.bots > 0);
  const waiting = r.players.filter((p) => !p.host && !p.ready).length;
  return `<div class="sec" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
      <div><div class="mut">CÓDIGO DA SALA</div><div class="big">${esc(r.code)}</div></div>
      <div style="flex:1;min-width:220px"><b>${esc(r.name)}</b> <span class="mut">· ${r.priv ? '🔒 privada' : '🌐 pública'}</span><br>
      <button class="btn2" data-a="copy" data-t="${esc(r.code)}">📋 COPIAR CÓDIGO</button>${link ? `<button class="btn2" data-a="copy" data-t="${esc(link)}">🔗 COPIAR LINK</button>` : ''}</div>
      <div class="mppill">${r.players.length}/${r.max} jogadores</div></div>
    <div class="mpgrid"><div>
      <div class="sec"><h3>👥 JOGADORES</h3><div class="pls">${pls}</div></div>
      <div class="sec"><h3>💬 CHAT</h3><div id="mpchatlog"></div><input type="text" id="mp-chat" maxlength="140" placeholder="Digite e aperte Enter"></div></div>
      <div><div class="sec"><h3>⚙ PARTIDA</h3>
        <label>MODO</label><div class="modes">${modes}</div>
        <label>BOTS (completam a sala · 0–${MP.maxBots})</label><input type="number" id="mp-bots" min="0" max="${MP.maxBots}" value="${r.bots}" ${host ? '' : 'disabled'}>
        ${host ? `<label>NOME DA SALA</label><input type="text" id="mp-rname" maxlength="22" value="${esc(r.name)}"><label class="chk"><input type="checkbox" id="mp-rpriv" ${r.priv ? 'checked' : ''}> Sala privada</label>` : '<p class="mut">Só o anfitrião muda as configurações.</p>'}
      </div>
      <div class="sec">${playing ? '<p class="mut">🎮 Partida em andamento. Você entra na próxima!</p>' : ''}
        ${host ? `<button class="btn2 go" data-a="start" ${canStart ? '' : 'disabled'}>▶ INICIAR PARTIDA</button>${!canStart && !playing ? '<p class="mut">Chame ao menos 1 amigo ou coloque bots.</p>' : waiting ? `<p class="mut">${waiting} jogador(es) ainda não marcaram pronto — você pode iniciar assim mesmo.</p>` : ''}${playing ? '<button class="btn2 red" data-a="endmatch">⏹ ENCERRAR PARTIDA</button>' : ''}`
          : `<button class="btn2 ${me.ready ? 'red' : 'grn'}" data-a="ready" ${playing ? 'disabled' : ''}>${me.ready ? '✖ CANCELAR PRONTO' : '✔ ESTOU PRONTO'}</button><p class="mut">Aguardando o anfitrião iniciar…</p>`}
        <button class="btn2 red" data-a="leave">🚪 SAIR DA SALA</button></div></div></div>
    <div class="err">${esc(MP.err)}</div>`;
}

function render() {
  const body = $q('#mpbody'); if (!body) return;
  const st_ = $q('#mpst');
  if (st_) { st_.textContent = MP.connected ? '🟢 conectado' : MP.ws ? '🟡 conectando…' : '🔴 desconectado'; st_.className = 'mppill ' + (MP.connected ? 'ok' : MP.ws ? '' : 'bad'); }
  if (!MP.open) return;
  const ae = document.activeElement, aid = ae && ae.id && panel.contains(ae) ? ae.id : null;
  const ss = aid && ae.selectionStart != null ? [ae.selectionStart, ae.selectionEnd] : null;
  const keep = {};
  for (const id of ['mp-url', 'mp-cname', 'mp-cmode', 'mp-cbots', 'mp-code', 'mp-chat']) { const e = $q('#' + id); if (e) keep[id] = e.value; }
  const cpv = $q('#mp-cpriv'); if (cpv) keep.priv = cpv.checked;
  body.innerHTML = !MP.connected ? viewConnect() : !MP.room ? viewHome() : viewRoom();
  for (const id in keep) { const e = $q('#' + id); if (e && id !== 'priv') e.value = keep[id]; }
  if ('priv' in keep && $q('#mp-cpriv')) $q('#mp-cpriv').checked = keep.priv;
  renderChatLog();
  if (aid) { const e = $q('#' + aid); if (e) { e.focus(); if (ss) try { e.setSelectionRange(ss[0], ss[1]); } catch (_) {} } }
}

panel.addEventListener('keydown', (e) => e.stopPropagation());
panel.addEventListener('keyup', (e) => e.stopPropagation());
panel.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'mp-chat') { const v = e.target.value.trim(); if (v) send({ t: 'chat', m: v }); e.target.value = ''; }
  else if (e.target.id === 'mp-code') doJoin();
});
panel.addEventListener('input', (e) => { if (e.target.id === 'mp-code') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
panel.addEventListener('change', (e) => {
  const id = e.target.id, r = MP.room;
  if (!r || r.hostId !== MP.id) return;
  if (id === 'mp-bots') send({ t: 'set', bots: Math.max(0, Math.min(MP.maxBots, e.target.value | 0)) });
  else if (id === 'mp-rname') send({ t: 'set', name: e.target.value });
  else if (id === 'mp-rpriv') send({ t: 'set', priv: e.target.checked });
});

function doJoin(code) {
  code = (code || ($q('#mp-code') || {}).value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) { MP.err = 'Digite o código da sala.'; render(); return; }
  sendHello(); MP.err = ''; send({ t: 'join', code });
}

function makeRoster(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ n: NAMES[(i * 7 + 3) % NAMES.length], c: Math.random() * CS.length | 0, w: Math.random() < .3 ? Math.random() * WS.length | 0 : 0, p: Math.random() * PS.length | 0, f: Math.random() * FC.length | 0 });
  }
  return out;
}

panel.addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const a = b.dataset.a;
  try { sfx(700, .05); } catch (_) {}
  if (a === 'close') return closePanel();
  if (a === 'reconnect') { const u = $q('#mp-url'); if (u && u.value.trim()) { MP.url = u.value.trim(); try { localStorage.setItem('vxmp_url', MP.url); } catch (_) {} } disconnect(); setTimeout(connect, 50); return; }
  if (a === 'create') {
    sendHello();
    send({ t: 'create', name: $q('#mp-cname').value, mode: $q('#mp-cmode').value, bots: $q('#mp-cbots').value | 0, priv: $q('#mp-cpriv').checked });
    return;
  }
  if (a === 'join') return doJoin();
  if (a === 'joinpub') return doJoin(b.dataset.c);
  if (a === 'refresh') return send({ t: 'list' });
  if (a === 'leave') { send({ t: 'leave' }); MP.room = null; MP.chat = []; render(); return; }
  if (a === 'ready') { const me = MP.room.players.find((p) => p.id === MP.id); send({ t: 'ready', v: !(me && me.ready) }); return; }
  if (a === 'kick') return send({ t: 'kick', id: +b.dataset.id });
  if (a === 'mode') return send({ t: 'set', mode: b.dataset.m });
  if (a === 'endmatch') return send({ t: 'endmatch' });
  if (a === 'copy') {
    const t = b.dataset.t;
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('📋 Copiado!'), () => { prompt('Copie:', t); });
    return;
  }
  if (a === 'start') {
    const r = MP.room; if (!r || r.hostId !== MP.id) return;
    send({ t: 'start', mode: r.mode, map: (window.vxPickMap ? window.vxPickMap() : Object.keys(MAPS)[0]), bots: makeRoster(r.bots) });
  }
});

/* botão no lobby */
function addLobbyButton() {
  const box = $q('#vxR'); if (!box || $q('#mpbtn')) return !!box;
  const b = document.createElement('button');
  b.id = 'mpbtn'; b.className = 'lb big r'; b.innerHTML = '<i>👥</i><span>MULTIPLAYER</span>';
  b.onclick = () => { try { sfx(700, .05); } catch (_) {} openPanel(); };
  box.appendChild(b);
  return true;
}
addLobbyButton();
const _iv = setInterval(() => { if (addLobbyButton()) clearInterval(_iv); }, 300);

/* convite por link: ?sala=ABCDE */
const invite = (new URLSearchParams(location.search).get('sala') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
if (invite) {
  const iv = setInterval(() => {
    if (st === 'menu' && !$q('#reg')) {
      clearInterval(iv); openPanel();
      const wait = setInterval(() => { if (MP.connected) { clearInterval(wait); doJoin(invite); } }, 200);
      setTimeout(() => clearInterval(wait), 8000);
    }
  }, 400);
}

/* ======================================================== PARTIDA */
function teamMap(m) {
  const t = new Map(), c = [0, 0];
  if (m.mode === 'sq') {
    m.players.forEach((p, i) => { const k = i % 2; t.set(p.id, k); c[k]++; });
    (m.bots || []).forEach((_, i) => { const k = c[0] <= c[1] ? 0 : 1; t.set('b' + i, k); c[k]++; });
  } else {
    let n = 0;
    m.players.forEach((p) => t.set(p.id, n++));
    (m.bots || []).forEach((_, i) => t.set('b' + i, n++));
  }
  return t;
}

// referências às funções originais (já com os remendos dos outros scripts)
const _spawn = spawn, _jump = jump, _hurt = hurt, _bot = bot, _air = air, _autoPick = autoPick,
  _spawnLoot = spawnLoot, _spawnLoots = spawnLoots, _tracer = tracer, _shoot = shoot,
  _throwG = throwG, _rocket = rocket, _placeWall = placeWall, _playEmote = playEmote,
  _update = update, _showMenu = showMenu, _launch = launch;

function mkEnt(info, team, i) {
  const sk = info.skin || {}, base = CS[sk.c] || CS[0], s = Object.assign({}, base);
  if (mode == 'sq') s.b = team ? 0xff3b4e : 0x2b7bff;
  else if (!info.human) s.b = PAL[i % PAL.length];
  const e = {
    id: i, team, name: info.name, bot: true, rem: true, human: !!info.human, netbot: !info.human,
    nid: info.nid, kills: 0, skill: .55 + Math.random() * .5, ws: WS[sk.w] || WS[0],
    mesh: mkChar(s, info.name, PS[sk.p] || PS[0], sk.f || 0),
  };
  world.add(e.mesh);
  _spawn(e);
  return e;
}

function onStart(m) {
  // limpa qualquer tela por cima e sai da busca/loja
  try { closePanel(); } catch (_) {}
  try { closeO(); } catch (_) {}
  $q('#modal').style.display = 'none';
  ln = null; $q('#launch').style.display = 'none'; $q('#launch').classList.remove('on');
  const fl = $q('#flash'); fl.classList.add('f'); setTimeout(() => fl.classList.remove('f'), 350);

  MP.match = true; MP.ready = false; MP.pend = [];
  MP.simId = m.hostId; MP.isSim = m.hostId === MP.id;
  MP.byNid = new Map(); MP.lootMap = new Map(); MP.hitq.clear(); MP.lc = 0;
  mode = MODEK.includes(m.mode) ? m.mode : 'br';
  mapk = MAPS[m.map] ? m.map : Object.keys(MAPS)[0];

  startMatch();               // monta mundo, avião, zona, loot e P
  postStart(m);

  MP.ready = true;
  const q = MP.pend; MP.pend = [];
  for (const x of q) x.t === 's' ? onState(x) : onEvent(x);

  btnLeave.style.display = 'block'; matchFeed.style.display = 'block';
  matchFeed.innerHTML = '';
  pushMatchChat('', '💬 Enter abre o chat');
  if (MP.isSim) sendInit();
}

function postStart(m) {
  const tm = teamMap(m), humans = m.players, bots = m.bots || [];
  P.nid = MP.id; P.human = true; P.rem = false; P.bot = false;
  P.team = tm.get(MP.id);
  MP.byNid.set(MP.id, P);

  // uniforme do time no Esquadrão
  if (mode == 'sq' && P.team === 1) {
    world.remove(P.mesh);
    const s = Object.assign({}, CS[SV.eq.c]); s.b = 0xff3b4e;
    P.mesh = mkChar(s, 'Você', PS[SV.eq.p], SV.eq.f);
    world.add(P.mesh);
  }
  _spawn(P);
  if (P.sl && P.sl[P.wp] >= 0) setGun(P, P.sl[P.wp]);

  for (let i = 1; i < ents.length; i++) world.remove(ents[i].mesh);
  ents.length = 1;

  const others = [];
  for (const p of humans) if (p.id !== MP.id) others.push({ nid: p.id, name: p.name, skin: p.skin, human: true });
  bots.forEach((b, i) => others.push({ nid: 'b' + i, name: b.n, skin: { c: b.c, w: b.w, p: b.p, f: b.f }, human: false }));
  others.forEach((info, k) => {
    const e = mkEnt(info, tm.get(info.nid), k + 1);
    if (!info.human && MP.isSim) e.rem = false;      // o simulador comanda os bots
    ents.push(e); MP.byNid.set(info.nid, e);
  });
}

// o simulador também cuida do loot inicial e do avião
const lootKeep = (k, v) => typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean';
function serLoot(l) {
  const o = {};
  for (const k in l) {
    if (k === 'm' || k === 'gone') continue;
    const v = l[k]; if (!lootKeep(k, v)) continue;
    if ((k === 'vx' || k === 'vy' || k === 'vz' || k === 'n') && v === 0) continue;
    if (k === 'on' && v === true) continue;
    o[k] = typeof v === 'number' ? r2(v) : v;
  }
  return o;
}
function desLoot(o) {
  const { t, id, x, z, ...rest } = o;
  MP.applying = true;
  try { const l = _spawnLoot(t, id, x, z, rest); if (l.nid) MP.lootMap.set(l.nid, l); return l; } finally { MP.applying = false; }
}

function sendInit() {
  const arr = loot.filter((l) => l.on && l.nid).map(serLoot);
  evAll({ k: 'lt0' });
  for (let i = 0; i < arr.length; i += 100) evAll({ k: 'lt', a: arr.slice(i, i + 100) });
  if (pl) evAll({ k: 'pl', a: pl.a.map(r2), b: pl.b.map(r2), dur: r2(pl.dur), ya: r2(pl.ya), t: r2(pl.t) });
  if (zone) sendZone();
}

/* ------------------------------------------------ ganchos do jogo */
spawnLoots = function () {
  if (!MP.match) return _spawnLoots();
  MP.initLoot = true;
  try { _spawnLoots(); } finally { MP.initLoot = false; }
  if (MP.isSim) { loot.forEach((l, i) => { l.nid = 'i' + i; MP.lootMap.set(l.nid, l); }); }
  else { for (const l of loot) world.remove(l.m); loot.length = 0; }   // chega pela rede
};

spawnLoot = function (t, id, x, z, o) {
  const l = _spawnLoot(t, id, x, z, o);
  if (MP.match && !MP.applying && !MP.initLoot && MP.ready) {
    l.nid = MP.id + '_' + (++MP.lc);
    MP.lootMap.set(l.nid, l);
    evAll({ k: 'lt', a: [serLoot(l)] });
  }
  return l;
};

hurt = function (e, d, by, head) {
  if (!MP.match || !MP.ready) return _hurt(e, d, by, head);
  if (!MP.applying) {
    if (!e || !e.alive || st != 'play') return _hurt(e, d, by, head);
    if (e.rem) {
      // alvo simulado por outro cliente: quem atira avisa o dono
      if (by === P || (by && by.netbot && !by.rem)) forwardHit(e, d, by, head);
      return;
    }
    if (by && by.rem && by.nid !== undefined) return;     // explosão "fantasma" de outro jogador
  }
  const was = !!(e && e.alive);
  _hurt(e, d, by, head);
  if (was && !e.alive && !e.rem) evAll({ k: 'die', v: e.nid, by: by && by.nid !== undefined ? by.nid : -1, hd: head ? 1 : 0 });
};

function forwardHit(e, d, by, head) {
  if (by === P && d > 0) {
    const eff = Math.min(d, (e.hp || 100) + (e.shd || 0));
    if (eff > 0) {
      P.dmg = (P.dmg || 0) + eff;
      try { dmgNum(e.x, e.y + 2.3, e.z, eff, head, false); } catch (_) {}
      const h = $q('#hm'); h.style.opacity = 1; h.style.borderColor = head ? '#ffd21f' : '#ff2e4d'; setTimeout(() => h.style.opacity = 0, 110);
      try { sfx(head ? 1100 : 800, .05, 'sine', .05); } catch (_) {}
      e.hp = Math.max(1, (e.hp || 100) - d);
    }
  }
  const key = e.nid + '|' + (by.nid !== undefined ? by.nid : -1);
  const q = MP.hitq.get(key);
  if (q) { q.d += d; q.hd = q.hd || head; } else MP.hitq.set(key, { v: e.nid, by: by.nid !== undefined ? by.nid : -1, d, hd: head });
}

function flushHits() {
  if (!MP.hitq.size) return;
  for (const q of MP.hitq.values()) {
    const tgt = MP.byNid.get(q.v); if (!tgt) continue;
    evTo(tgt.human ? q.v : 'sim', { k: 'hit', v: q.v, by: q.by, d: Math.round(q.d), hd: q.hd ? 1 : 0 });
  }
  MP.hitq.clear();
}

bot = function (b, dt) {
  if (!MP.match) return _bot(b, dt);
  if (b.rem) return;                        // quem manda no bot é o simulador
  MP.shooter = b; MP.trb = [];
  try { _bot(b, dt); } finally { flushTr(b); }
};
air = function (e, ix, iz, dt) { if (e.rem) return; return _air(e, ix, iz, dt); };
autoPick = function (e) { if (e.rem) return; return _autoPick(e); };
spawn = function (e) { if (e.rem && MP.match) return; return _spawn(e); };
jump = function (e) { if (e.rem && MP.match) return; return _jump(e); };

tracer = function (o, d, t, c) {
  _tracer(o, d, t, c);
  if (MP.shooter && MP.trb && MP.trb.length < 12) MP.trb.push([r1(o.x), r1(o.y), r1(o.z), r2(d.x), r2(d.y), r2(d.z), r1(t)]);
};
function flushTr(e) {
  if (MP.trb && MP.trb.length && MP.ready) evAll({ k: 'tr', s: e.nid, a: MP.trb });
  MP.shooter = null; MP.trb = null;
}
shoot = function (e, o, dir, w, sm) {
  if (!MP.match || e !== P) return _shoot.apply(this, arguments);
  MP.shooter = e; MP.trb = [];
  try { return _shoot.apply(this, arguments); } finally { flushTr(e); }
};

throwG = function (e, d, v) {
  _throwG(e, d, v);
  if (MP.match && MP.ready && !MP.applying && (e === P || (e.netbot && !e.rem))) {
    const g = gren[gren.length - 1];
    if (g) evAll({ k: 'gr', s: e.nid, x: r2(g.x), y: r2(g.y), z: r2(g.z), vx: r2(g.vx), vy: r2(g.vy), vz: r2(g.vz) });
  }
};
rocket = function (e, o, d) {
  _rocket(e, o, d);
  if (MP.match && MP.ready && !MP.applying && e === P) evAll({ k: 'rk', s: e.nid, o: [r2(o.x), r2(o.y), r2(o.z)], d: [r2(d.x), r2(d.y), r2(d.z)] });
};
placeWall = function (e, fromBot) {
  const ok = _placeWall(e, fromBot);
  if (ok && MP.match && MP.ready && !MP.applying && (e === P || (e.netbot && !e.rem))) evAll({ k: 'wl', s: e.nid, fb: fromBot ? 1 : 0 });
  return ok;
};
playEmote = function (e, id) {
  const r = _playEmote.apply(this, arguments);
  if (MP.match && MP.ready && !MP.applying && e === P && P.emote) evAll({ k: 'em', s: P.nid, id: P.emote.type });
  return r;
};

/* -------------------------------------------- estado dos jogadores */
function sendState() {
  const e = P;
  const f = (e.crouch ? 1 : 0) | (e.slideT > 0 ? 2 : 0) | (e.spr ? 4 : 0) | (e.gnd ? 8 : 0) | (e.climb > 0 ? 16 : 0);
  send({ t: 's', d: { x: r2(e.x), y: r2(e.y), z: r2(e.z), w: r2(e.yaw), p: PHC[e.ph] | 0, a: e.alive ? 1 : 0, h: Math.round(e.hp), g: Math.round(e.shd || 0), i: e.sl ? e.sl[e.wp] : -1, s: r1(e.sp || 0), f } });
}

function sendSim() {
  const a = [];
  for (const e of ents) {
    if (!e.netbot || e.rem) continue;
    const f = (e.gnd ? 8 : 0);
    a.push([+String(e.nid).slice(1), r1(e.x), r1(e.y), r1(e.z), r2(e.yaw), PHC[e.ph] | 0, e.alive ? 1 : 0, r1(e.sp || 0), e.sl ? e.sl[0] : 0, Math.round(e.hp), f]);
  }
  if (a.length) send({ t: 's', d: { k: 'b', a } });
}
function sendZone() {
  if (!zone) return;
  const z = {};
  for (const k of ['cx', 'cz', 'r', 'ph', 't', 'sh', 'sd', 'fr', 'fx', 'fz', 'tr', 'tx', 'tz']) if (typeof zone[k] === 'number') z[k] = r2(zone[k]);
  send({ t: 's', d: { k: 'z', z } });
}

function applyState(e, d) {
  if (!e || e === P) return;
  const t = e.net || (e.net = {});
  t.x = d.x; t.y = d.y; t.z = d.z; t.yaw = d.w;
  const ph = PHN[d.p] || 'ground';
  if (e.ph === 'plane' && ph !== 'plane') { e.mesh.visible = true; e.x = d.x; e.y = d.y; e.z = d.z; }
  e.ph = ph;
  e.sp = d.s || 0; e.hp = d.h; e.shd = d.g || 0;
  e.crouch = !!(d.f & 1); e.slideT = (d.f & 2) ? .3 : 0; e.spr = !!(d.f & 4); e.gnd = !!(d.f & 8); e.climb = (d.f & 16) ? .3 : 0;
  if (d.i !== undefined && d.i !== e.curW) {
    e.curW = d.i; e.sl = [d.i, -1]; e.wp = 0;
    if (d.i >= 0) { try { setGun(e, d.i); } catch (_) {} }
  }
  if (d.a && !e.alive) revive(e, d);
  else if (!d.a && e.alive) netKill(e, null, 0);
}

function revive(e, d) {
  e.alive = true; e.hp = d.h || 100; e.dp = 0; e.kx = e.kz = 0;
  e.x = d.x; e.y = d.y; e.z = d.z;
  e.mesh.visible = true; e.mesh.rotation.set(0, e.yaw || 0, 0);
}

function onState(m) {
  const d = m.d;
  if (d.k === 'b') {
    if (MP.isSim) return;
    for (const a of d.a) {
      const e = MP.byNid.get('b' + a[0]);
      if (e) applyState(e, { x: a[1], y: a[2], z: a[3], w: a[4], p: a[5], a: a[6], s: a[7], i: a[8], h: a[9], f: a[10] });
    }
    return;
  }
  if (d.k === 'z') {
    if (!MP.isSim && zone && d.z) Object.assign(zone, d.z);
    return;
  }
  applyState(MP.byNid.get(m.f), d);
}

function netKill(v, k, head) {
  if (!v || !v.alive) return;
  v.hp = 0; v.alive = false; v.dT = T; v.dp = 0;
  if (k && k !== v) { k.kills = (k.kills || 0) + 1; if (mode == 'sq') score[k.team]++; }
  if (k) { const dx = v.x - (k.x ?? v.x), dz = v.z - (k.z ?? v.z), l = hy(dx, dz) || 1; v.kx = (v.kx || 0) + dx / l * 4; v.kz = (v.kz || 0) + dz / l * 4; }
  feed.unshift({ t: `${k ? k.name : 'Zona'} ➜ ${v.name}${head ? ' 🎯' : ''}`, l: 5, c: k === P || v === P });
  try { sfx(160, .25, 'triangle', .07, 50); } catch (_) {}
  if (v.mesh.userData.chute) v.mesh.userData.chute.visible = false;
}
function netGone(e) {
  if (!e || e === P) return;
  if (e.alive) netKill(e, null, 0);
  e.gone = true; e.mesh.visible = false;
}

function onEvent(m) {
  const d = m.d, from = MP.byNid.get(m.f);
  switch (d.k) {
    case 'hit': {
      const v = MP.byNid.get(d.v); if (!v || v.rem) return;
      const by = MP.byNid.get(d.by) || { name: '?', kills: 0, team: -1 };
      MP.applying = true;
      try { hurt(v, d.d, by, !!d.hd); } finally { MP.applying = false; }
      return;
    }
    case 'die': {
      const v = MP.byNid.get(d.v), k = d.by === -1 ? null : MP.byNid.get(d.by);
      if (v && v.alive) netKill(v, k, d.hd);
      return;
    }
    case 'tr': {
      const e = MP.byNid.get(d.s); if (!e || e === P) return;
      for (const a of d.a) tracer({ x: a[0], y: a[1], z: a[2] }, { x: a[3], y: a[4], z: a[5] }, a[6], e.ws ? e.ws.t : 0xfff07a);
      flash(e); e.rc = 1;
      const dist = hy(P.x - e.x, P.z - e.z);
      if (dist < 70) { try { sfx(150, .05, 'sawtooth', .03 * (1 - dist / 70), 50); } catch (_) {} }
      return;
    }
    case 'gr': {
      const e = MP.byNid.get(d.s); if (!e) return;
      gren.push({ x: d.x, y: d.y, z: d.z, vx: d.vx, vy: d.vy, vz: d.vz, t: 2.2, own: e, m: ball(.24, 0x2f6a3a, d.x, d.y, d.z) });
      return;
    }
    case 'rk': {
      const e = MP.byNid.get(d.s); if (!e) return;
      MP.applying = true;
      try { rocket(e, { x: d.o[0], y: d.o[1], z: d.o[2] }, { x: d.d[0], y: d.d[1], z: d.d[2] }); } finally { MP.applying = false; }
      return;
    }
    case 'wl': {
      const e = MP.byNid.get(d.s); if (!e) return;
      e.wallCd = 0;
      MP.applying = true;
      try { placeWall(e, !!d.fb); } finally { MP.applying = false; }
      return;
    }
    case 'em': {
      const e = MP.byNid.get(d.s); if (!e || e === P) return;
      MP.applying = true;
      try { _playEmote(e, d.id); } finally { MP.applying = false; }
      return;
    }
    case 'lt0': {
      for (const l of loot) world.remove(l.m);
      loot.length = 0; MP.lootMap.clear();
      return;
    }
    case 'lt': for (const o of d.a) if (!MP.lootMap.has(o.nid)) desLoot(o); return;
    case 'pk': {
      for (const n of d.n) { const l = MP.lootMap.get(n); if (l && l.on) { l.on = false; l.gone = 1; l.m.visible = false; } }
      return;
    }
    case 'pl': {
      if (!pl) return;
      pl.a = d.a; pl.b = d.b; pl.dur = d.dur; pl.ya = d.ya; pl.t = d.t;
      pl.m.rotation.y = pl.ya; pl.x = pl.a[0]; pl.z = pl.a[1];
      if (zone && mode == 'br') zone.t = pl.dur + ZW0 - pl.t;
      return;
    }
  }
}

/* quando o simulador cai, quem fica assume os bots */
function takeSim(offline) {
  MP.isSim = true;
  for (const e of ents) {
    if (e.netbot) { e.rem = false; e.goal = null; e.tg = null; e.t = 0; if (e.sl == null) e.sl = [0, -1]; if (!e.am) e.am = [99, 0]; }
    else if (offline && e.human && e !== P) netGone(e);
  }
  if (!offline) toast('🖥 Você assumiu os bots da partida');
}

/* ------------------------------------------------- loop de rede */
update = function (dt) {
  if (!MP.match || !MP.ready) return _update(dt);

  const k = Math.min(1, dt * 12);
  for (const e of ents) {
    if (!e.rem || !e.net || e.gone) continue;
    if (e.ph === 'plane') continue;
    const t = e.net, dist = hy(t.x - e.x, t.z - e.z);
    if (dist > 25 || Math.abs(t.y - e.y) > 40) { e.x = t.x; e.y = t.y; e.z = t.z; }
    else { e.x += (t.x - e.x) * k; e.y += (t.y - e.y) * k; e.z += (t.z - e.z) * k; }
    let dy = ((t.yaw - e.yaw + PI * 3) % (PI * 2)) - PI;
    e.yaw += dy * k;
  }

  _update(dt);

  for (const e of ents) {
    if (e.rem && e.net && !e.gone && (e.ph === 'fall' || e.ph === 'chute')) { e.yaw = e.net.yaw; e.mesh.rotation.y = e.yaw; }
  }

  const now = performance.now();
  flushHits();

  // loot recolhido por mim (ou por bots que simulo) → todo mundo
  let pk = null;
  for (const l of loot) if (!l.on && l.nid && !l.gone) { l.gone = 1; (pk = pk || []).push(l.nid); }
  if (pk) evAll({ k: 'pk', n: pk });

  if (now - MP.lastS > 66) { MP.lastS = now; sendState(); }
  if (MP.isSim) {
    if (now - MP.lastB > 100) { MP.lastB = now; sendSim(); }
    if (zone && now - MP.lastZ > 400) { MP.lastZ = now; sendZone(); }
  }
};

showMenu = function () {
  const was = MP.match;
  if (was) {
    MP.match = false; MP.ready = false;
    evAll({ k: 'gone' });
    send({ t: 'back' });
    btnLeave.style.display = 'none'; matchFeed.style.display = 'none'; chatIn.style.display = 'none';
  }
  _showMenu();
  if (was && MP.room) setTimeout(openPanel, 80);
};
$q('#tomenu').onclick = () => showMenu();
$q('#sback').onclick = () => showMenu();

launch = function () {
  if (MP.connected && MP.room) {
    if (st === 'play' || st === 'end') showMenu(); else openPanel();
    return;
  }
  return _launch();
};
$q('#play').onclick = () => launch();
$q('#again').onclick = () => launch();

btnLeave.onclick = () => {
  if (!MP.match) return;
  if (confirm('Sair da partida e voltar para a sala?')) { try { document.exitPointerLock && document.exitPointerLock(); } catch (_) {} showMenu(); }
};

// 'gone' vindo de outro jogador
const _onEvent = onEvent;
onEvent = function (m) { if (m.d && m.d.k === 'gone') { netGone(MP.byNid.get(m.f)); return; } return _onEvent(m); };

// partida online nunca congela só pra você: perder o mouse (Esc) não pausa o jogo
document.addEventListener('pointerlockchange', () => { if (MP.match && !document.pointerLockElement) paused = false; });

/* chat durante a partida */
addEventListener('keydown', (e) => {
  if (!MP.match || st !== 'play') return;
  if (e.code === 'Enter' && !MP.typing) {
    e.preventDefault();
    MP.typing = true; try { document.exitPointerLock && document.exitPointerLock(); } catch (_) {}
    chatIn.style.display = 'block'; chatIn.value = ''; setTimeout(() => chatIn.focus(), 20);
  }
});
chatIn.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') { const v = chatIn.value.trim(); if (v) send({ t: 'chat', m: v }); closeChat(); }
  else if (e.key === 'Escape') closeChat();
});
chatIn.addEventListener('keyup', (e) => e.stopPropagation());
function closeChat() { MP.typing = false; chatIn.style.display = 'none'; chatIn.blur(); for (const k in K) K[k] = 0; }

// ao terminar sua partida, avisa o botão de "jogar de novo" que agora volta para a sala
const _fin = finish;
finish = function (w, t, p) {
  _fin(w, t, p);
  if (MP.match) { btnLeave.style.display = 'none'; const b = $q('#again'); if (b) b.textContent = 'VOLTAR PARA A SALA'; }
};
const _sm = startMatch;
startMatch = function () {
  const b = $q('#again');
  if (b) b.textContent = MP.match ? 'VOLTAR PARA A SALA' : 'JOGAR DE NOVO';
  return _sm.apply(this, arguments);
};

})();
