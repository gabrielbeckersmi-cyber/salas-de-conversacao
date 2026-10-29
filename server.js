'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { AccessToken } = require('livekit-server-sdk');
const C = require('./lib/classes');
const D = require('./lib/dinamicas');
const auth = require('./lib/auth');
const R = require('./lib/report');
const { ReportStore } = require('./lib/reportstore');

function build(env) {
  const cfg = {
    port: Number(env.PORT || 3000),
    lkUrl: env.LIVEKIT_URL || '',
    lkKey: env.LIVEKIT_API_KEY || '',
    lkSecret: env.LIVEKIT_API_SECRET || '',
    password: env.PROFESSOR_PASSWORD || '',
    dataFile: env.DATA_FILE || path.join(__dirname, 'data', 'classes.json'),
    retentionDays: Number(env.RETENTION_DAYS || 30),
    reportsFile: env.REPORTS_FILE || '',
    serviceAccount: env.FIREBASE_SERVICE_ACCOUNT || '',
    firebaseUrl: env.FIREBASE_DB_URL === undefined ? 'https://app-conversacao-default-rtdb.firebaseio.com' : env.FIREBASE_DB_URL
  };
  cfg.sessionSecret = env.SESSION_SECRET ||
    crypto.createHash('sha256').update('salas-conversacao:' + cfg.password + ':' + cfg.lkSecret).digest('hex');
  const lkReady = !!(cfg.lkUrl && cfg.lkKey && cfg.lkSecret);

  const store = {};
  const reports = new ReportStore({
    file: cfg.reportsFile || path.join(path.dirname(cfg.dataFile), 'reports.json'),
    firebaseUrl: cfg.firebaseUrl,
    serviceAccount: cfg.serviceAccount
  });
  const PUBLIC = path.join(__dirname, 'public');
  const LK_CLIENT = path.join(__dirname, 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js');

  // ---------- persistência ----------
  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(cfg.dataFile, 'utf8'));
      const limit = Date.now() - cfg.retentionDays * 86400000;
      Object.keys(j.classes || {}).forEach(function (id) {
        const c = j.classes[id];
        if (c.createdAt < limit) return;
        Object.keys(c.students).forEach(function (k) { c.students[k].online = false; });
        store[id] = c;
      });
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Não consegui ler', cfg.dataFile, e.message);
    }
  }
  let saveTimer = null;
  function save(now) {
    clearTimeout(saveTimer);
    const run = function () {
      try {
        fs.mkdirSync(path.dirname(cfg.dataFile), { recursive: true });
        const tmp = cfg.dataFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ classes: store }));
        fs.renameSync(tmp, cfg.dataFile);
      } catch (e) {
        console.error('Não consegui salvar', e.message);
      }
    };
    if (now) run(); else saveTimer = setTimeout(run, 400);
  }

  // ---------- LiveKit ----------
  const tokenCache = new Map();
  async function lkToken(o) {
    if (!lkReady) throw new C.AppError(500, 'livekit', 'LiveKit não configurado no servidor (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET).');
    const key = o.room + '|' + o.identity + (o.listener ? '|L' : '');
    const hit = tokenCache.get(key);
    if (hit && hit.exp > Date.now() + 600000) return hit.jwt;
    const at = new AccessToken(cfg.lkKey, cfg.lkSecret, { identity: o.identity, name: o.name, ttl: '3h' });
    // ouvinte: só assiste (não publica) e fica invisível para os outros participantes
    at.addGrant(o.listener
      ? { roomJoin: true, room: o.room, canPublish: false, canSubscribe: true, canPublishData: false, hidden: true }
      : { roomJoin: true, room: o.room, canPublish: true, canSubscribe: true, canPublishData: false });
    const jwt = await at.toJwt();
    tokenCache.set(key, { jwt: jwt, exp: Date.now() + 3 * 3600000 });
    if (tokenCache.size > 5000) tokenCache.clear();
    return jwt;
  }
  function lkRoomName(c, roomId) { return c.id + '-r' + c.round + '-' + roomId; }

  function lobbyRoomName(c) { return c.id + '-lobby'; }
  function cleanTid(t) { return /^[a-z0-9]{4,16}$/i.test(String(t || '')) ? String(t) : 'x'; }

  // Cada professor conectado usa uma identidade própria no LiveKit (prof-<id>).
  // Com a mesma identidade, o LiveKit derruba o professor anterior e o áudio ficava cortando.
  async function teacherSnapshot(c, tid) {
    const v = C.teacherView(c);
    const identity = 'prof-' + cleanTid(tid);
    v.lk = { url: cfg.lkUrl };
    v.link = '/aula/' + c.id;
    v.report = '/relatorio/' + c.id;
    if (C.isLive(c)) {
      for (const r of v.rooms) {
        const room = lkRoomName(c, r.id);
        try {
          r.lk = { room: room, token: await lkToken({ identity: identity, name: 'Professor', room: room }) };
        } catch (e) { r.lkError = e.message; }
      }
    }
    if (c.phase !== 'done') {
      const room = lobbyRoomName(c);
      try { v.lobby = { room: room, token: await lkToken({ identity: identity, name: 'Professor', room: room }) }; } catch (e) { v.lobbyError = e.message; }
    }
    return v;
  }
  async function studentSnapshot(c, s) {
    const v = C.studentView(c, s);
    if (v.room && C.isLive(c)) {
      const room = lkRoomName(c, v.room.id);
      try {
        v.room.lk = { url: cfg.lkUrl, room: room, token: await lkToken({ identity: s.pid, name: s.name, room: room, listener: s.listener }) };
      } catch (e) { v.room.lkError = e.message; }
    } else if (c.phase !== 'done') {
      // sem sala (espera, intervalo, encerramento): vai para a sala de espera em vídeo
      const room = lobbyRoomName(c);
      try {
        v.lobby = { url: cfg.lkUrl, room: room, token: await lkToken({ identity: s.pid, name: s.name, room: room, listener: s.listener }) };
      } catch (e) { v.lobbyError = e.message; }
    }
    return v;
  }

  // ---------- conexões em tempo real ----------
  const registry = new Map(); // classId -> { teachers:Set, students:Map(studentId -> Set) }
  function reg(id) {
    if (!registry.has(id)) registry.set(id, { teachers: new Set(), students: new Map() });
    return registry.get(id);
  }
  function send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
  // relatório: atualizado no máximo a cada 20 s durante a aula e na hora quando algo importante acontece
  const reportAt = new Map();
  function reportNow(c) {
    if (!c.startedAt) return;
    reportAt.set(c.id, Date.now());
    reports.put(R.buildReport(c), true).catch(function () { /* ignorar */ });
  }
  const reportTrail = new Map();
  function reportSoon(c) {
    if (!c.startedAt || c.phase === 'done') return;
    const wait = 20000 - (Date.now() - (reportAt.get(c.id) || 0));
    if (wait <= 0) { reportNow(c); return; }
    if (reportTrail.has(c.id)) return;
    const t = setTimeout(function () { reportTrail.delete(c.id); reportNow(c); }, wait);
    if (t.unref) t.unref();
    reportTrail.set(c.id, t);
  }
  const pending = new Map();
  function schedule(c) {
    save();
    reportSoon(c);
    if (pending.has(c.id)) return;
    pending.set(c.id, setTimeout(function () {
      pending.delete(c.id);
      pushAll(c).catch(function (e) { console.error('push', e.message); });
    }, 50));
  }
  async function pushAll(c) {
    const r = registry.get(c.id);
    if (!r) return;
    for (const ws of Array.from(r.teachers)) {
      const snap = await teacherSnapshot(c, ws.tid);
      send(ws, { type: 'state', data: snap });
    }
    for (const [sid, set] of r.students) {
      const s = c.students[sid];
      if (!s) {
        set.forEach(function (ws) { send(ws, { type: 'removed' }); ws.close(4002, 'removed'); });
        r.students.delete(sid);
        continue;
      }
      const snap = await studentSnapshot(c, s);
      set.forEach(function (ws) { send(ws, { type: 'state', data: snap }); });
    }
  }
  function disconnectStudent(c, studentId) {
    const r = registry.get(c.id);
    if (!r) return;
    const set = r.students.get(studentId);
    if (set) set.forEach(function (ws) { send(ws, { type: 'removed' }); ws.close(4002, 'removed'); });
    r.students.delete(studentId);
  }

  // ---------- relógio das rodadas ----------
  const timers = new Map();
  function armTimer(c) {
    clearTimeout(timers.get(c.id));
    timers.delete(c.id);
    if (!(C.isLive(c) || c.phase === 'closing') || !c.endsAt) return;
    const ms = Math.max(0, c.endsAt - Date.now());
    timers.set(c.id, setTimeout(function () {
      C.timeUp(c);
      armTimer(c);
      schedule(c);
      reportNow(c);
    }, ms));
  }

  // ---------- HTTP ----------
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));

  const attempts = new Map();
  function tooManyLogins(ip) {
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter(function (t) { return now - t < 600000; });
    attempts.set(ip, list);
    return list.length >= 8;
  }

  function needTeacher(req, res, next) {
    const h = req.get('authorization') || '';
    const p = auth.verify(cfg.sessionSecret, h.startsWith('Bearer ') ? h.slice(7) : '');
    if (!p || p.role !== 'teacher') return res.status(401).json({ error: 'auth', message: 'Entre com a senha do professor.' });
    next();
  }
  function getClass(id) {
    const c = store[String(id)];
    if (!c) throw new C.AppError(404, 'class', 'Aula não encontrada. Confira o link.');
    return c;
  }

  app.get('/healthz', function (req, res) { res.json({ ok: true, livekit: lkReady, relatorios: reports.mode, relatoriosErro: reports.lastError || undefined }); });

  app.get('/vendor/livekit-client.umd.js', function (req, res) {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(LK_CLIENT);
  });

  app.get('/', function (req, res) { res.sendFile(path.join(PUBLIC, 'index.html')); });
  app.get('/aula/:id', function (req, res) { res.sendFile(path.join(PUBLIC, 'aluno.html')); });
  app.get('/aula', function (req, res) { res.sendFile(path.join(PUBLIC, 'aluno.html')); });
  app.get(['/professor', '/professor/:id'], function (req, res) { res.sendFile(path.join(PUBLIC, 'professor.html')); });
  app.use(express.static(PUBLIC, { index: false, maxAge: 0 }));

  // --- aluno ---
  app.get('/api/classes/:id/public', function (req, res) {
    const c = getClass(req.params.id);
    res.json({ title: c.title, phase: c.phase, allowLate: !!c.allowLate, endMessage: c.phase === 'done' ? (c.endMessage || null) : null });
  });

  app.post('/api/classes/:id/join', function (req, res) {
    const c = getClass(req.params.id);
    const s = C.joinStudent(c, { name: req.body.name, level: req.body.level, resumeId: req.body.resumeId });
    schedule(c);
    res.json({ studentId: s.id, pid: s.pid, name: s.name, level: s.level, listener: !!s.listener });
  });

  function chatTargets(c, roomId) {
    const r = reg(c.id);
    const out = [];
    const room = c.rooms.find(function (x) { return x.id === roomId; });
    if (roomId === 'lobby') {
      // sala de espera: quem não está em uma sala ao vivo
      C.studentList(c).forEach(function (st) {
        if (C.isLive(c) && C.roomOf(c, st.pid)) return;
        const set = r.students.get(st.id);
        if (set) set.forEach(function (ws) { out.push(ws); });
      });
    } else if (room) room.members.forEach(function (pid) {
      const st = C.byPid(c, pid);
      const set = st && r.students.get(st.id);
      if (set) set.forEach(function (ws) { out.push(ws); });
    });
    r.teachers.forEach(function (ws) { out.push(ws); });
    return out;
  }
  function sendChat(c, roomId, msg) {
    chatTargets(c, roomId).forEach(function (ws) { send(ws, { type: 'chat', roomId: roomId, msg: msg }); });
    save();
  }

  app.post('/api/classes/:id/chat', function (req, res) {
    const c = getClass(req.params.id);
    const s = c.students[String(req.body.studentId)];
    if (!s) throw new C.AppError(404, 'student', 'Aluno não encontrado.');
    const r = C.studentSay(c, s, req.body.text, req.body.speak === true);
    sendChat(c, r.roomId, r.msg);
    res.json({ ok: true });
  });


  // ---------- dinâmicas da sala ----------
  function dynCopy(c, room) {
    return Object.assign({}, room, { members: room.members.filter(function (p) { const x = C.byPid(c, p); return x && !x.listener; }) });
  }
  function dynRoom(c, studentId) {
    const s = c.students[String(studentId)];
    if (!s) throw new C.AppError(404, 'student', 'Aluno não encontrado.');
    if (s.listener) throw new C.AppError(403, 'listener', 'Como ouvinte você não consegue interagir.');
    const room = C.isLive(c) ? C.roomOf(c, s.pid) : null;
    return { s: s, room: room ? dynCopy(c, room) : null };
  }
  function pushDyn(c, room0) {
    const room = dynCopy(c, room0);
    const r = reg(c.id);
    const now = Date.now();
    room.members.forEach(function (pid) {
      const st = C.byPid(c, pid);
      const set = st && r.students.get(st.id);
      if (set) set.forEach(function (ws) { send(ws, { type: 'dyn', roomId: room.id, data: D.view(c, room, pid, now) }); });
    });
    save();
  }
  app.get('/api/classes/:id/dyn', function (req, res) {
    const c = getClass(req.params.id);
    const x = dynRoom(c, req.query.studentId);
    res.json({ roomId: x.room ? x.room.id : null, data: x.room ? D.view(c, x.room, x.s.pid, Date.now()) : null });
  });
  app.post('/api/classes/:id/dyn', function (req, res) {
    const c = getClass(req.params.id);
    const x = dynRoom(c, req.body.studentId);
    if (!x.room) throw new C.AppError(409, 'no-room', 'Você ainda não está em uma sala.');
    D.act(c, x.room, String(req.body.action || ''), Date.now());
    pushDyn(c, x.room);
    res.json({ ok: true });
  });

  app.get('/api/classes/:id/chat', function (req, res) {
    const c = getClass(req.params.id);
    const s = c.students[String(req.query.studentId)];
    if (!s) throw new C.AppError(404, 'student', 'Aluno não encontrado.');
    const room = C.isLive(c) ? C.roomOf(c, s.pid) : null;
    res.json({ roomId: room ? room.id : null, messages: room ? C.chatHistory(c, room.id) : [], lobby: C.chatHistory(c, 'lobby') });
  });

  app.get('/api/professor/classes/:id/chat', needTeacher, function (req, res) {
    const c = getClass(req.params.id);
    const rooms = {};
    c.rooms.forEach(function (r) { rooms[r.id] = C.chatHistory(c, r.id); });
    rooms.lobby = C.chatHistory(c, 'lobby');
    res.json({ rooms: rooms });
  });

  app.post('/api/classes/:id/score', function (req, res) {
    const c = getClass(req.params.id);
    const s = c.students[String(req.body.studentId)];
    if (!s) throw new C.AppError(404, 'student', 'Aluno não encontrado.');
    const best = C.submitScore(c, s, req.body.score);
    schedule(c);
    res.json({ best: best });
  });

  // saída imediata (botão Sair ou fechar a página): o professor vê o aluno offline na hora
  app.post('/api/classes/:id/leave', function (req, res) {
    const c = getClass(req.params.id);
    const sid = String((req.body && req.body.studentId) || '');
    const s = c.students[sid];
    if (s) {
      const set = reg(c.id).students.get(sid);
      if (set) { Array.from(set).forEach(function (ws) { try { ws.close(4005, 'left'); } catch (e) { /* ignorar */ } }); reg(c.id).students.delete(sid); }
      C.setOnline(c, sid, false);
      schedule(c);
    }
    res.json({ ok: true });
  });

  let temasCache = { at: 0, v: { t1: '', t2: '' } };
  async function fetchTema(key) {
    const base = String(cfg.firebaseUrl || '').replace(/\/$/, '');
    const r = await fetch(base + '/' + key + '.json', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('firebase ' + r.status);
    const v = await r.json();
    return v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  app.get('/api/temas', async function (req, res) {
    if (cfg.firebaseUrl && Date.now() - temasCache.at > 60000) {
      try {
        const r = await Promise.all([fetchTema('temaEscolhido1'), fetchTema('temaEscolhido2')]);
        temasCache = { at: Date.now(), v: { t1: r[0], t2: r[1] } };
      } catch (e) {
        temasCache.at = Date.now() - 45000; // tenta de novo em 15 s; enquanto isso mostra o último valor
      }
    }
    res.json(temasCache.v);
  });

  // problemas de conexão avisados pelo navegador (alimentam o relatório)
  const PROBLEM_KINDS = ['video-falhou', 'video-caiu', 'video-reconectando', 'qualidade-ruim'];
  const problemAt = new Map();
  function noteProblem(c, kind, who, minGapMs) {
    if (c.phase === 'done') return;
    const k = c.id + '|' + kind + '|' + who;
    const now = Date.now();
    if (now - (problemAt.get(k) || 0) < (minGapMs || 15000)) return;
    problemAt.set(k, now);
    if (problemAt.size > 20000) problemAt.clear();
    C.logProblem(c, kind, who, now);
    reportSoon(c);
  }
  app.post('/api/classes/:id/problem', function (req, res) {
    const c = getClass(req.params.id);
    const s = c.students[String(req.body.studentId)];
    const kind = String(req.body.kind || '');
    if (s && PROBLEM_KINDS.indexOf(kind) !== -1) noteProblem(c, kind, s.name, 20000);
    res.json({ ok: true });
  });
  app.post('/api/professor/classes/:id/problem', needTeacher, function (req, res) {
    const c = getClass(req.params.id);
    const kind = String(req.body.kind || '');
    if (PROBLEM_KINDS.indexOf(kind) !== -1) noteProblem(c, kind, 'Professor', 20000);
    res.json({ ok: true });
  });

  // relatório: público por link (o código da aula é impossível de adivinhar); a lista completa exige login
  app.get('/relatorio/:id', function (req, res) { res.sendFile(path.join(PUBLIC, 'relatorio.html')); });
  app.get('/relatorios', function (req, res) { res.sendFile(path.join(PUBLIC, 'relatorios.html')); });
  app.get('/api/relatorio/:id', async function (req, res) {
    const live = store[String(req.params.id)];
    let rep = null;
    if (live && live.startedAt) rep = R.buildReport(live); // aula em memória: sempre o dado mais novo
    if (!rep) rep = await reports.get(req.params.id);
    if (!rep) throw new C.AppError(404, 'report', 'Relatório não encontrado. Ele só existe para aulas que chegaram a começar.');
    res.set('Cache-Control', 'no-store');
    res.json(rep);
  });
  app.get('/api/professor/relatorios', needTeacher, async function (req, res) {
    const list = await reports.list();
    Object.keys(store).forEach(function (id) {
      const c = store[id];
      if (c.startedAt && !list.some(function (r) { return r.id === id; })) list.push(R.buildReport(c));
    });
    res.json({
      mode: reports.mode,
      error: reports.lastError,
      reports: list.map(function (r) { return { id: r.id, title: r.title, startedAt: r.startedAt, endedAt: r.endedAt, phase: r.phase, totals: r.totals, problems: r.problems && r.problems.total }; })
        .sort(function (a, b) { return (b.startedAt || 0) - (a.startedAt || 0); })
    });
  });

  app.post('/api/classes/:id/call', function (req, res) {
    const c = getClass(req.params.id);
    const s = c.students[String(req.body.studentId)];
    if (!s) throw new C.AppError(404, 'student', 'Aluno não encontrado.');
    C.setCall(c, s, !!req.body.on);
    schedule(c);
    res.json({ ok: true });
  });

  // --- professor ---
  app.post('/api/professor/login', function (req, res) {
    if (!cfg.password) return res.status(500).json({ error: 'config', message: 'PROFESSOR_PASSWORD não foi definida no servidor.' });
    if (tooManyLogins(req.ip)) return res.status(429).json({ error: 'rate', message: 'Muitas tentativas. Espere alguns minutos.' });
    if (!auth.safeEqual(req.body.password || '', cfg.password)) {
      attempts.get(req.ip).push(Date.now());
      return res.status(401).json({ error: 'auth', message: 'Senha incorreta.' });
    }
    const token = auth.sign(cfg.sessionSecret, { role: 'teacher', exp: Date.now() + 7 * 86400000 });
    res.json({ token: token });
  });

  app.get('/api/professor/classes', needTeacher, function (req, res) {
    const list = Object.keys(store).map(function (k) { return C.summary(store[k]); })
      .sort(function (a, b) { return b.createdAt - a.createdAt; });
    res.json({ classes: list, livekit: lkReady });
  });

  app.post('/api/professor/classes', needTeacher, function (req, res) {
    const c = C.createClass(store, { title: req.body.title, roundMinutes: req.body.roundMinutes });
    save();
    res.json(C.summary(c));
  });

  app.get('/api/professor/classes/:id', needTeacher, async function (req, res) {
    res.json(await teacherSnapshot(getClass(req.params.id), req.query.tid));
  });

  app.post('/api/professor/classes/:id/act', needTeacher, function (req, res) {
    const c = getClass(req.params.id);
    const b = req.body || {};
    switch (b.action) {
      case 'plan': C.autoPlan(c, b.n); break;
      case 'move': C.moveStudent(c, b.pid, b.roomId || null); break;
      case 'add-room': C.addRoom(c); break;
      case 'remove-room': C.removeRoom(c, b.roomId); break;
      case 'start':
        if (!lkReady) throw new C.AppError(500, 'livekit', 'LiveKit não configurado no servidor (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET).');
        C.startRound(c); armTimer(c); reportNow(c); break;
      case 'end-round': C.endRound(c); armTimer(c); reportNow(c); break;
      case 'end-class': C.endClass(c, 'professor'); armTimer(c); reportNow(c); break;
      case 'hear': C.setHear(c, b.roomId, b.mode); break;
      case 'answer': C.answerCall(c, b.roomId); break;
      case 'bmic': C.setBroadcastMic(c, b.roomIds); break;
      case 'allow-late': C.setAllowLate(c, b.on); break;
      case 'end-message': C.setEndMessage(c, b); break;
      case 'chat': C.teacherSay(c, b.roomIds, b.text, b.name).forEach(function (x) { sendChat(c, x.roomId, x.msg); }); break;
      case 'kick': { const s = C.kick(c, b.pid); disconnectStudent(c, s.id); break; }
      default: throw new C.AppError(400, 'action', 'Ação desconhecida.');
    }
    schedule(c);
    res.json({ ok: true });
  });

  app.use(function (req, res) {
    res.status(404).json({ error: 'not-found', message: 'Página não encontrada.' });
  });
  app.use(function (err, req, res, next) { // eslint-disable-line no-unused-vars
    if (err instanceof C.AppError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'json', message: 'Pedido inválido.' });
    console.error(err);
    res.status(500).json({ error: 'server', message: 'Erro interno do servidor.' });
  });

  // ---------- WebSocket ----------
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', function (req, socket, head) {
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (e) { socket.destroy(); return; }
    if (u.pathname !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, function (ws) { wss.emit('connection', ws, u); });
  });

  wss.on('connection', function (ws, u) {
    ws.isAlive = true;
    ws.on('pong', function () { ws.isAlive = true; });
    ws.on('error', function () {});
    const role = u.searchParams.get('role');
    const c = store[u.searchParams.get('class')];
    if (!c) { send(ws, { type: 'error', code: 'class', message: 'Aula não encontrada. Confira o link.' }); ws.close(4004); return; }

    if (role === 'teacher') {
      const p = auth.verify(cfg.sessionSecret, u.searchParams.get('token'));
      if (!p || p.role !== 'teacher') { send(ws, { type: 'error', code: 'auth', message: 'Sessão expirada.' }); ws.close(4001); return; }
      const r = reg(c.id);
      ws.tid = cleanTid(u.searchParams.get('tid'));
      r.teachers.add(ws);
      ws.on('close', function (code) {
        r.teachers.delete(ws);
        if ((code === 1006 || ws.hbKilled) && c.phase !== 'done') { C.logProblem(c, 'professor-caiu', 'Professor'); reportSoon(c); }
      });
      teacherSnapshot(c, ws.tid).then(function (snap) { send(ws, { type: 'state', data: snap }); });
      return;
    }

    const sid = u.searchParams.get('student');
    const s = c.students[sid];
    if (role !== 'student' || !s) { send(ws, { type: 'error', code: 'student', message: 'Entre novamente na aula.' }); ws.close(4003); return; }
    const r = reg(c.id);
    if (!r.students.has(sid)) r.students.set(sid, new Set());
    r.students.get(sid).add(ws);
    C.setOnline(c, sid, true);
    if (C.isLive(c) && !C.roomOf(c, s.pid) && !s.late) C.placeStudentLive(c, s); // quem entrou depois (liberado pelo professor) espera em "Sem sala"
    ws.on('close', function (code) {
      // queda de verdade (não foi o botão Sair nem fechar a página): vai para o relatório
      if ((code === 1006 || ws.hbKilled) && c.phase !== 'done' && c.students[sid]) {
        noteProblem(c, ws.hbKilled ? 'aluno-timeout' : 'aluno-caiu', s.name, 8000);
      }
      const set = r.students.get(sid);
      if (set) {
        set.delete(ws);
        if (!set.size) { r.students.delete(sid); if (c.students[sid]) C.setOnline(c, sid, false); schedule(c); }
      }
    });
    studentSnapshot(c, s).then(function (snap) { send(ws, { type: 'state', data: snap }); });
    schedule(c);
  });

  const heartbeat = setInterval(function () {
    wss.clients.forEach(function (ws) {
      if (ws.isAlive) ws.missed = 0; else ws.missed = (ws.missed || 0) + 1;
      if (ws.missed >= 2) { ws.hbKilled = true; ws.terminate(); return; } // sem resposta por ~10 s: conexão perdida
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* ignorar */ }
    });
  }, 5000);
  heartbeat.unref();

  function listen(port) {
    load();
    reports.load();
    Object.keys(store).forEach(function (id) {
      const c = store[id];
      if (c.startedAt && c.phase !== 'done') C.logProblem(c, 'servidor-reiniciou', '');
      if ((C.isLive(c) || c.phase === 'closing') && c.endsAt && c.endsAt <= Date.now()) C.timeUp(c);
      armTimer(c);
      if (c.startedAt) reportNow(c);
    });
    return new Promise(function (resolve) {
      server.listen(port === undefined ? cfg.port : port, function () { resolve(server.address().port); });
    });
  }
  function close() {
    clearInterval(heartbeat);
    clearTimeout(saveTimer);
    timers.forEach(function (t) { clearTimeout(t); });
    wss.clients.forEach(function (ws) { ws.terminate(); });
    return new Promise(function (resolve) { server.close(function () { resolve(); }); });
  }

  return { server, store, listen, close, cfg, lkReady, save };
}

module.exports = { build };

if (require.main === module) {
  const app = build(process.env);
  if (!app.lkReady) console.warn('AVISO: LiveKit não configurado. Defina LIVEKIT_URL, LIVEKIT_API_KEY e LIVEKIT_API_SECRET.');
  if (!app.cfg.password) console.warn('AVISO: defina PROFESSOR_PASSWORD para poder entrar no painel do professor.');
  app.listen().then(function (port) { console.log('Salas de Conversação rodando na porta ' + port); });
  const stop = function () { app.save(true); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
