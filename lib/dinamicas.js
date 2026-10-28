'use strict';
// Dinâmicas por sala: o estado fica no servidor para todos da sala verem o mesmo.
// O conteúdo vem de lib/dinamicas.json (campo "niveis" limita a dinâmica/itens a esses níveis).
const fs = require('fs');
const path = require('path');

let CATALOG = { dinamicas: [] };
function load(file) {
  try { CATALOG = JSON.parse(fs.readFileSync(file || path.join(__dirname, 'dinamicas.json'), 'utf8')); }
  catch (e) { console.error('dinamicas.json inválido:', e.message); CATALOG = { dinamicas: [] }; }
  if (!Array.isArray(CATALOG.dinamicas)) CATALOG.dinamicas = [];
  return CATALOG;
}
load();
let QUESTIONS = [];
function loadQ(file) {
  try { QUESTIONS = (JSON.parse(fs.readFileSync(file || path.join(__dirname, 'perguntas.json'), 'utf8')).perguntas) || []; }
  catch (e) { console.error('perguntas.json inválido:', e.message); QUESTIONS = []; }
}
loadQ();
function pickQ(st, level, rnd) {
  const pool = QUESTIONS.filter(function (q) { return okLevel(q, level); });
  if (!pool.length) return null;
  const used = (st.qused = st.qused || []);
  let free = pool.filter(function (q) { return used.indexOf(q.en) === -1; });
  if (!free.length) { st.qused = []; free = pool; }
  const q = free[Math.floor(rnd() * free.length)];
  st.qused.push(q.en);
  return { en: q.en, pt: q.pt };
}

function roomLevel(c, room) {
  const lv = new Set();
  room.members.forEach(function (pid) {
    Object.keys(c.students).forEach(function (id) { if (c.students[id].pid === pid) lv.add(c.students[id].level); });
  });
  return lv.size === 1 ? Array.from(lv)[0] : 'basico'; // sala mista: usa o conteúdo mais simples
}
function okLevel(obj, level) { return !obj.niveis || obj.niveis.indexOf(level) !== -1; }
function games(level) { return CATALOG.dinamicas.filter(function (g) { return okLevel(g, level) && g.conteudo && g.conteudo.length; }); }
function gameById(id) { return CATALOG.dinamicas.find(function (g) { return g.id === id; }) || null; }
function shuffle(a, rnd) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

// itens "simples" (en/pt) permitidos para o nível, evitando repetir os já usados
function pickItems(st, game, level, n, rnd, pool) {
  pool = pool || game.conteudo.filter(function (x) { return okLevel(x, level); });
  const used = (st.used[game.id] = st.used[game.id] || []);
  let free = pool.filter(function (x) { return used.indexOf(x.en) === -1; });
  if (free.length < n) { st.used[game.id] = []; free = pool.slice(); }
  const out = shuffle(free, rnd).slice(0, n);
  out.forEach(function (x) { st.used[game.id].push(x.en); });
  while (out.length < n) out.push(pool[Math.floor(rnd() * pool.length)]); // sala maior que o conteúdo (improvável)
  return out;
}
function strip(x) { return x ? { en: x.en, pt: x.pt } : null; }

function deal(st, game, members, level, rnd) {
  const d = {};
  if (game.tipo === 'impostor') {
    const cats = game.conteudo.filter(function (x) { return okLevel(x, level); });
    const used = (st.used[game.id] = st.used[game.id] || []);
    let all = [];
    cats.forEach(function (cat) { cat.palavras.filter(function (w) { return okLevel(w, level); }).forEach(function (w) { all.push({ cat: cat.categoria, w: w }); }); });
    let free = all.filter(function (x) { return used.indexOf(x.w.en) === -1; });
    if (!free.length) { st.used[game.id] = []; free = all; }
    const p = free[Math.floor(rnd() * free.length)];
    st.used[game.id].push(p.w.en);
    d.cat = p.cat; d.word = strip(p.w);
    d.impostor = members.length ? members[Math.floor(rnd() * members.length)] : null;
    d.revealed = false;
  } else if (game.tipo === 'mimica' || game.tipo === 'quemsou') {
    const items = pickItems(st, game, level, Math.max(members.length, 1), rnd);
    d.by = {};
    members.forEach(function (pid, i) { d.by[pid] = strip(items[i]); });
    d.endsAt = null;
  } else {
    d.item = strip(pickItems(st, game, level, 1, rnd)[0]);
  }
  return d;
}

function keyOf(c, room) { return c.round + ':' + room.id; }
function stateOf(c, room, rnd) {
  rnd = rnd || Math.random;
  c.dyn = c.dyn || {};
  const k = keyOf(c, room);
  if (!c.dyn[k]) {
    const level = roomLevel(c, room);
    const gs = games(level);
    c.dyn[k] = { v: 1, gameId: gs.length ? gs[Math.floor(rnd() * gs.length)].id : null, started: false, deal: null, used: {} };
  }
  return c.dyn[k];
}
// remove estados de rodadas antigas (pequeno, mas evita crescer sem fim)
function names(c, pids) {
  const m = {};
  Object.keys(c.students).forEach(function (id) { const s = c.students[id]; if (pids.indexOf(s.pid) !== -1) m[s.pid] = s.name; });
  return m;
}

function act(c, room, action, now, rnd) {
  rnd = rnd || Math.random;
  const st = stateOf(c, room, rnd);
  const level = roomLevel(c, room);
  const game = gameById(st.gameId);
  if (!game) return st;
  if (action === 'next') {
    const gs = games(level).filter(function (g) { return g.id !== st.gameId; });
    if (gs.length) st.gameId = gs[Math.floor(rnd() * gs.length)].id;
    st.started = false; st.deal = null;
  } else if (action === 'start') {
    if (!st.started) { st.started = true; st.deal = deal(st, game, room.members, level, rnd); }
  } else if (action === 'again') {
    if (st.started) st.deal = deal(st, game, room.members, level, rnd);
  } else if (action === 'mimica') {
    if (st.started && game.tipo === 'mimica' && (!st.deal.endsAt || st.deal.endsAt < now)) st.deal.endsAt = now + (game.segundos || 30) * 1000;
  } else if (action === 'reveal') {
    if (st.started && game.tipo === 'impostor') st.deal.revealed = true;
  } else if (action === 'qnext') {
    st.q = pickQ(st, level, rnd); st.qn = (st.qn || 0) + 1;
  } else return st;
  st.v += 1;
  return st;
}

// o que ESTE aluno pode ver (segredos ficam no servidor)
function view(c, room, pid, now, rnd) {
  rnd = rnd || Math.random;
  const st = stateOf(c, room, rnd);
  const level = roomLevel(c, room);
  const game = gameById(st.gameId);
  if (!st.q) { st.q = pickQ(st, level, rnd); st.qn = st.qn || 1; }
  const qpart = { pergunta: st.q, pn: st.qn || 1 };
  if (!game) return Object.assign({ v: st.v, empty: true, now: now }, qpart);
  const out = Object.assign({}, qpart, { v: st.v, now: now, id: game.id, nome: game.nome, tipo: game.tipo, explicacao: game.explicacao, started: !!st.started, outras: games(level).length > 1 });
  if (!st.started || !st.deal) return out;
  const d = st.deal;
  const nm = names(c, room.members);
  if (game.tipo === 'impostor') {
    out.categoria = d.cat;
    out.impostor = d.impostor === pid;
    out.palavra = out.impostor && !d.revealed ? null : d.word;
    out.revelado = !!d.revealed;
    if (d.revealed) out.nomeImpostor = nm[d.impostor] || '—';
  } else if (game.tipo === 'mimica') {
    if (!d.by[pid]) { const it = pickItems(st, game, level, 1, rnd)[0]; d.by[pid] = strip(it); }
    out.palavra = d.by[pid];
    out.endsAt = d.endsAt; out.segundos = game.segundos || 30;
  } else if (game.tipo === 'quemsou') {
    room.members.forEach(function (p) { if (!d.by[p]) d.by[p] = strip(pickItems(st, game, level, 1, rnd)[0]); });
    out.outros = room.members.filter(function (p) { return p !== pid; }).map(function (p) { return { nome: nm[p] || '—', id: d.by[p] }; });
  } else {
    out.item = d.item;
  }
  return out;
}

module.exports = { load, act, view, stateOf, games, roomLevel, gameById };
