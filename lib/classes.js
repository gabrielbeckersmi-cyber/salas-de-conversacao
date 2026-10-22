'use strict';
// Máquina de estados de uma aula. Nada aqui conhece HTTP, WebSocket ou LiveKit.
//
// Fases:  lobby -> r1 -> between -> r2 -> done
//   lobby/between: planejamento (sala de espera + montagem das salas)
//   r1/r2: rodada em andamento (salas ao vivo)
// Só entra aluno novo em "lobby". Quem já entrou pode voltar (recarregar a página) até o fim.

const crypto = require('crypto');
const G = require('./grouping');

const LEVELS = ['basico', 'intermediario'];
const LEVEL_NAME = { basico: 'Básico', intermediario: 'Intermediário' };
const LIVE = ['r1', 'r2'];
const PLANNING = ['lobby', 'between'];
const MAX_STUDENTS = Number(process.env.MAX_STUDENTS || 80);

class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
function rid(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHA[crypto.randomInt(ALPHA.length)];
  return s;
}

function normName(s) {
  return String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}
function nameKey(s) {
  return normName(s).toLocaleLowerCase('pt-BR');
}

function isLive(c) { return LIVE.indexOf(c.phase) !== -1; }
function isPlanning(c) { return PLANNING.indexOf(c.phase) !== -1; }

function createClass(store, opts) {
  const o = opts || {};
  const title = normName(o.title).slice(0, 60) || 'Aula de conversação';
  const minutes = Math.min(30, Math.max(1, Math.round(Number(o.roundMinutes) || 15)));
  let id;
  do { id = rid(10); } while (store[id]);
  const c = {
    id: id,
    title: title,
    createdAt: Date.now(),
    phase: 'lobby',
    round: 0,
    roundMinutes: minutes,
    endsAt: null,
    students: {},      // por id secreto do aluno
    rooms: [],         // { id, no, members: [pid] }
    roomSeq: 0,
    met: [],           // pares (pids) que já conversaram
    hear: null,        // { roomId, mode: 'listen' | 'talk' }
    allowLate: false,  // professor liberou a entrada de alunos depois do início
    bmic: [],          // salas que recebem o microfone do professor (transmissão)
    chat: {},          // 'rodada:sala' -> [mensagens]
    chatSeq: 0,
    endMessage: null,  // { text, url, label } mostrado ao aluno no fim da aula
    plan: { repeats: 0 }
  };
  store[id] = c;
  return c;
}

function studentList(c) { return Object.keys(c.students).map(function (k) { return c.students[k]; }); }
function byPid(c, pid) { return studentList(c).find(function (s) { return s.pid === pid; }) || null; }
function pidMap(c) {
  const m = {};
  studentList(c).forEach(function (s) { m[s.pid] = s; });
  return m;
}
function roomOf(c, pid) { return c.rooms.find(function (r) { return r.members.indexOf(pid) !== -1; }) || null; }
function renumber(c) { c.rooms.forEach(function (r, i) { r.no = i + 1; }); }

function joinStudent(c, input) {
  const i = input || {};
  if (i.resumeId && c.students[i.resumeId]) return c.students[i.resumeId];
  const name = normName(i.name);
  if (name.length < 2) throw new AppError(400, 'name', 'Digite seu nome (mínimo 2 letras).');
  if (name.length > 30) throw new AppError(400, 'name', 'Nome muito longo (máximo 30 caracteres).');
  if (LEVELS.indexOf(i.level) === -1) throw new AppError(400, 'level', 'Escolha Básico ou Intermediário.');
  const key = nameKey(name);
  if (/^(prof|professor|professora|teacher|admin)(\s|$|[^a-zà-ú])/i.test(key + ' ')) throw new AppError(400, 'name', 'Esse nome não pode ser usado. Digite o seu nome.');
  const same = studentList(c).find(function (s) { return nameKey(s.name) === key; });
  if (same) {
    if (same.online) throw new AppError(409, 'duplicate', 'Já existe um aluno online com esse nome. Acrescente a inicial do sobrenome.');
    return same; // quem caiu e voltou sem o código salvo retoma o próprio lugar
  }
  if (c.phase === 'done') throw new AppError(403, 'done', 'Esta aula já terminou.');
  const late = c.phase !== 'lobby';
  if (late && !c.allowLate) throw new AppError(403, 'started', 'Esta aula já começou e não aceita novos alunos.');
  if (studentList(c).length >= MAX_STUDENTS) throw new AppError(403, 'full', 'Esta aula está lotada.');
  const s = { id: rid(24), pid: rid(8), name: name, level: i.level, joinedAt: Date.now(), online: false, callAt: null, late: late };
  c.students[s.id] = s;
  return s;
}

function setOnline(c, studentId, online) {
  const s = c.students[studentId];
  if (!s) return false;
  s.online = !!online;
  return true;
}

// Distribui automaticamente os alunos online em salas (n opcional).
function autoPlan(c, n, rnd) {
  if (!isPlanning(c)) throw new AppError(409, 'phase', 'Só dá para redistribuir antes da rodada começar.');
  const pool = studentList(c).filter(function (s) { return s.online; });
  const built = G.buildRound(
    pool.map(function (s) { return { id: s.pid, level: s.level }; }),
    new Set(c.met),
    { rooms: n ? Number(n) : undefined, levels: LEVELS, rnd: rnd }
  );
  c.rooms = [];
  c.roomSeq = 0;
  built.rooms.forEach(function (r) {
    c.roomSeq += 1;
    c.rooms.push({ id: 'm' + c.roomSeq, no: 0, members: r.members.slice() });
  });
  renumber(c);
  c.hear = null;
  c.bmic = [];
  c.plan = { repeats: built.repeats };
}

function addRoom(c) {
  if (!isPlanning(c) && !isLive(c)) throw new AppError(409, 'phase', 'A aula não está aberta para mudanças.');
  c.roomSeq += 1;
  const no = c.rooms.reduce(function (m, r) { return Math.max(m, r.no); }, 0) + 1;
  const room = { id: 'm' + c.roomSeq, no: no, members: [] };
  c.rooms.push(room);
  return room;
}

function removeRoom(c, roomId) {
  const r = c.rooms.find(function (x) { return x.id === roomId; });
  if (!r) throw new AppError(404, 'room', 'Sala não encontrada.');
  if (r.members.length) throw new AppError(409, 'not-empty', 'Mova os alunos para outra sala antes de remover esta.');
  c.rooms = c.rooms.filter(function (x) { return x !== r; });
  if (isPlanning(c)) renumber(c);
  if (c.hear && c.hear.roomId === roomId) c.hear = null;
  c.bmic = (c.bmic || []).filter(function (id) { return id !== roomId; });
}

function markMet(c, members) {
  const have = new Set(c.met);
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) have.add(G.pairKey(members[i], members[j]));
  }
  c.met = Array.from(have);
}

// roomId null = "sem sala".
function moveStudent(c, pid, roomId) {
  if (!isPlanning(c) && !isLive(c)) throw new AppError(409, 'phase', 'A aula não está aberta para mudanças.');
  const s = byPid(c, pid);
  if (!s) throw new AppError(404, 'student', 'Aluno não encontrado.');
  let target = null;
  if (roomId) {
    target = c.rooms.find(function (r) { return r.id === roomId; });
    if (!target) throw new AppError(404, 'room', 'Sala não encontrada.');
  }
  c.rooms.forEach(function (r) { r.members = r.members.filter(function (m) { return m !== pid; }); });
  s.callAt = null;
  if (target) {
    target.members.push(pid);
    if (isLive(c)) markMet(c, target.members);
  }
}

// Aluno conhecido que aparece sem sala durante a rodada (voltou depois de cair):
// vai para a menor sala do próprio nível com vaga; senão abre sala nova.
function placeStudentLive(c, s) {
  const pm = pidMap(c);
  const sameLevel = c.rooms.filter(function (r) {
    return r.members.length > 0 && r.members.every(function (m) { return pm[m] && pm[m].level === s.level; });
  }).sort(function (a, b) { return a.members.length - b.members.length; });
  let room = sameLevel.find(function (r) { return r.members.length < G.GROUP_MAX; })
    || sameLevel.find(function (r) { return r.members.length < G.GROUP_MAX + 1; });
  if (!room) room = addRoom(c);
  room.members.push(s.pid);
  markMet(c, room.members);
  return room;
}

function startRound(c, now) {
  if (!isPlanning(c)) throw new AppError(409, 'phase', 'A rodada já está em andamento ou a aula terminou.');
  const t = now || Date.now();
  if (!c.rooms.some(function (r) { return r.members.length; })) autoPlan(c);
  // quem está online e sem sala entra nas salas existentes antes de trancar
  studentList(c).forEach(function (s) {
    if (s.online && !roomOf(c, s.pid)) placeStudentLive(c, s);
  });
  c.rooms = c.rooms.filter(function (r) { return r.members.length > 0; });
  if (!c.rooms.length) throw new AppError(409, 'empty', 'Ainda não há alunos para formar salas.');
  renumber(c);
  c.rooms.forEach(function (r) { markMet(c, r.members); });
  c.round += 1;
  c.phase = 'r' + c.round;
  c.endsAt = t + c.roundMinutes * 60000;
  c.hear = null;
  c.bmic = [];
  c.chat = {};
  studentList(c).forEach(function (s) { s.callAt = null; });
}

function endRound(c) {
  if (!isLive(c)) return;
  c.endsAt = null;
  c.hear = null;
  c.bmic = [];
  studentList(c).forEach(function (s) { s.callAt = null; });
  if (c.phase === 'r1') {
    c.phase = 'between';
    autoPlan(c);
  } else {
    c.phase = 'done';
    c.rooms = [];
  }
}

function endClass(c) {
  c.phase = 'done';
  c.endsAt = null;
  c.hear = null;
  c.bmic = [];
  c.rooms = [];
  studentList(c).forEach(function (s) { s.callAt = null; });
}

function setHear(c, roomId, mode) {
  if (!isLive(c)) throw new AppError(409, 'phase', 'Só dá para ouvir e falar com uma rodada em andamento.');
  if (!roomId || !mode) { c.hear = null; return; }
  if (mode !== 'listen' && mode !== 'talk') throw new AppError(400, 'mode', 'Modo inválido.');
  if (!c.rooms.find(function (r) { return r.id === roomId; })) throw new AppError(404, 'room', 'Sala não encontrada.');
  c.hear = { roomId: roomId, mode: mode };
}

function setCall(c, s, on) {
  if (!isLive(c)) throw new AppError(409, 'phase', 'A rodada não está em andamento.');
  if (!roomOf(c, s.pid)) throw new AppError(409, 'no-room', 'Você ainda não está em uma sala.');
  s.callAt = on ? (s.callAt || Date.now()) : null;
}

function answerCall(c, roomId) {
  const r = c.rooms.find(function (x) { return x.id === roomId; });
  if (!r) throw new AppError(404, 'room', 'Sala não encontrada.');
  const pm = pidMap(c);
  r.members.forEach(function (p) { if (pm[p]) pm[p].callAt = null; });
}

function kick(c, pid) {
  const s = byPid(c, pid);
  if (!s) throw new AppError(404, 'student', 'Aluno não encontrado.');
  c.rooms.forEach(function (r) { r.members = r.members.filter(function (m) { return m !== pid; }); });
  delete c.students[s.id];
  return s;
}

function summary(c) {
  return {
    id: c.id, title: c.title, phase: c.phase, round: c.round, createdAt: c.createdAt,
    roundMinutes: c.roundMinutes, students: studentList(c).length
  };
}

// ----- o que cada lado enxerga -----

function teacherView(c) {
  return {
    id: c.id,
    title: c.title,
    phase: c.phase,
    round: c.round,
    roundMinutes: c.roundMinutes,
    endsAt: c.endsAt,
    now: Date.now(),
    students: studentList(c).map(function (s) {
      return { pid: s.pid, name: s.name, level: s.level, online: s.online, callAt: s.callAt };
    }),
    rooms: c.rooms.map(function (r) { return { id: r.id, no: r.no, members: r.members.slice() }; }),
    hear: c.hear,
    bmic: c.bmic || [],
    allowLate: !!c.allowLate,
    endMessage: c.endMessage || null,
    repeats: (c.plan && c.plan.repeats) || 0
  };
}

function setAllowLate(c, on) {
  if (c.phase === 'done') throw new AppError(409, 'phase', 'A aula já terminou.');
  c.allowLate = !!on;
}

// ---------- microfone do professor para várias salas ----------
function setBroadcastMic(c, roomIds) {
  if (!isLive(c)) throw new AppError(409, 'phase', 'Só dá para falar com as salas durante uma rodada.');
  const ids = Array.isArray(roomIds) ? roomIds : [];
  c.bmic = c.rooms.filter(function (r) { return ids.indexOf(r.id) !== -1; }).map(function (r) { return r.id; });
}

// ---------- chat por sala ----------
const CHAT_MAX_LEN = 300;
const CHAT_KEEP = 150;
function chatKey(c, roomId) { return c.round + ':' + roomId; }
function cleanText(t, max) { return String(t == null ? '' : t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\r/g, '').trim().slice(0, max); }
function pushChat(c, roomId, msg) {
  const k = chatKey(c, roomId);
  const list = c.chat[k] || (c.chat[k] = []);
  c.chatSeq += 1;
  const m = Object.assign({ id: c.chatSeq, at: Date.now() }, msg);
  list.push(m);
  if (list.length > CHAT_KEEP) list.splice(0, list.length - CHAT_KEEP);
  return m;
}
function studentSay(c, s, text) {
  if (!isLive(c)) throw new AppError(409, 'phase', 'O chat só funciona durante a rodada.');
  const r = roomOf(c, s.pid);
  if (!r) throw new AppError(409, 'no-room', 'Você ainda não está em uma sala.');
  const t = cleanText(text, CHAT_MAX_LEN);
  if (!t) throw new AppError(400, 'empty', 'Digite uma mensagem.');
  const now = Date.now();
  if (s.chatAt && now - s.chatAt < 600) throw new AppError(429, 'rate', 'Calma, você está enviando mensagens rápido demais.');
  s.chatAt = now;
  return { roomId: r.id, msg: pushChat(c, r.id, { from: 'aluno', pid: s.pid, name: s.name, text: t }) };
}
function teacherSay(c, roomIds, text, name) {
  if (!isLive(c)) throw new AppError(409, 'phase', 'O chat só funciona durante a rodada.');
  const t = cleanText(text, CHAT_MAX_LEN);
  if (!t) throw new AppError(400, 'empty', 'Digite uma mensagem.');
  const targets = roomIds === 'all' ? c.rooms : c.rooms.filter(function (r) { return Array.isArray(roomIds) && roomIds.indexOf(r.id) !== -1; });
  if (!targets.length) throw new AppError(400, 'rooms', 'Escolha ao menos uma sala.');
  return targets.map(function (r) {
    return { roomId: r.id, msg: pushChat(c, r.id, { from: 'professor', name: cleanText(name, 30) || 'Professor', text: t }) };
  });
}
function chatHistory(c, roomId) { return (c.chat[chatKey(c, roomId)] || []).slice(); }

// ---------- mensagem final ----------
function setEndMessage(c, input) {
  const i = input || {};
  const text = cleanText(i.text, 600);
  let url = cleanText(i.url, 500);
  let label = cleanText(i.label, 40);
  if (url) {
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    let ok = false;
    try { const u = new URL(url); ok = (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname; } catch (e) { ok = false; }
    if (!ok) throw new AppError(400, 'url', 'O link não parece válido. Exemplo: https://seusite.com.br/pagina');
    if (!label) label = 'Abrir link';
  } else { label = ''; }
  c.endMessage = (text || url) ? { text: text, url: url, label: label } : null;
}

const MAX_SCORE = 20000;
function submitScore(c, s, score) {
  const n = Math.floor(Number(score));
  if (!Number.isFinite(n) || n < 0 || n > MAX_SCORE) throw new AppError(400, 'score', 'Pontuação inválida.');
  const now = Date.now();
  if (s.scoreAt && now - s.scoreAt < 1500) throw new AppError(429, 'rate', 'Calma, muitas pontuações seguidas.');
  s.scoreAt = now;
  if (n > (s.best || 0)) s.best = n;
  return s.best || 0;
}
function ranking(c) {
  return studentList(c)
    .filter(function (s) { return s.best > 0; })
    .sort(function (a, b) { return b.best - a.best || a.joinedAt - b.joinedAt; })
    .slice(0, 5)
    .map(function (s) { return { pid: s.pid, name: s.name, score: s.best }; });
}
function studentView(c, s) {
  const pm = pidMap(c);
  const r = isLive(c) ? roomOf(c, s.pid) : null; // o rascunho das salas é só do professor
  const all = studentList(c);
  return {
    id: c.id,
    title: c.title,
    phase: c.phase,
    round: c.round,
    roundMinutes: c.roundMinutes,
    endsAt: c.endsAt,
    now: Date.now(),
    me: { pid: s.pid, name: s.name, level: s.level, best: s.best || 0 },
    ranking: ranking(c),
    endMessage: c.endMessage || null,
    waiting: { total: all.length, online: all.filter(function (x) { return x.online; }).length },
    room: r ? {
      id: r.id,
      no: r.no,
      members: r.members.filter(function (p) { return pm[p]; }).map(function (p) { return { pid: p, name: pm[p].name }; }),
      hear: c.hear && c.hear.roomId === r.id ? c.hear.mode : ((c.bmic || []).indexOf(r.id) !== -1 ? 'talk' : null),
      calling: !!s.callAt
    } : null
  };
}

module.exports = {
  AppError, LEVELS, LEVEL_NAME, isLive, isPlanning,
  createClass, joinStudent, setOnline, studentList, byPid, roomOf,
  autoPlan, addRoom, removeRoom, moveStudent, placeStudentLive,
  startRound, endRound, endClass, setHear, setCall, answerCall, kick,
  summary, teacherView, studentView, submitScore, ranking,
  setAllowLate, setBroadcastMic, studentSay, teacherSay, chatHistory, setEndMessage
};
