'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { AccessToken } = require('livekit-server-sdk');
const C = require('./lib/classes');
const auth = require('./lib/auth');

function build(env) {
  const cfg = {
    port: Number(env.PORT || 3000),
    lkUrl: env.LIVEKIT_URL || '',
    lkKey: env.LIVEKIT_API_KEY || '',
    lkSecret: env.LIVEKIT_API_SECRET || '',
    password: env.PROFESSOR_PASSWORD || '',
    dataFile: env.DATA_FILE || path.join(__dirname, 'data', 'classes.json'),
    retentionDays: Number(env.RETENTION_DAYS || 30)
  };
  cfg.sessionSecret = env.SESSION_SECRET ||
    crypto.createHash('sha256').update('salas-conversacao:' + cfg.password + ':' + cfg.lkSecret).digest('hex');
  const lkReady = !!(cfg.lkUrl && cfg.lkKey && cfg.lkSecret);

  const store = {};
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
    const key = o.room + '|' + o.identity;
    const hit = tokenCache.get(key);
    if (hit && hit.exp > Date.now() + 600000) return hit.jwt;
    const at = new AccessToken(cfg.lkKey, cfg.lkSecret, { identity: o.identity, name: o.name, ttl: '3h' });
    at.addGrant({ roomJoin: true, room: o.room, canPublish: true, canSubscribe: true, canPublishData: false });
    const jwt = await at.toJwt();
    tokenCache.set(key, { jwt: jwt, exp: Date.now() + 3 * 3600000 });
    if (tokenCache.size > 5000) tokenCache.clear();
    return jwt;
  }
  function lkRoomName(c, roomId) { return c.id + '-r' + c.round + '-' + roomId; }

  async function teacherSnapshot(c) {
    const v = C.teacherView(c);
    v.lk = { url: cfg.lkUrl };
    v.link = '/aula/' + c.id;
    if (C.isLive(c)) {
      for (const r of v.rooms) {
        const room = lkRoomName(c, r.id);
        try {
          r.lk = { room: room, token: await lkToken({ identity: 'professor', name: 'Professor', room: room }) };
        } catch (e) { r.lkError = e.message; }
      }
    }
    return v;
  }
  async function studentSnapshot(c, s) {
    const v = C.studentView(c, s);
    if (v.room && C.isLive(c)) {
      const room = lkRoomName(c, v.room.id);
      try {
        v.room.lk = { url: cfg.lkUrl, room: room, token: await lkToken({ identity: s.pid, name: s.name, room: room }) };
      } catch (e) { v.room.lkError = e.message; }
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
  const pending = new Map();
  function schedule(c) {
    save();
    if (pending.has(c.id)) return;
    pending.set(c.id, setTimeout(function () {
      pending.delete(c.id);
      pushAll(c).catch(function (e) { console.error('push', e.message); });
    }, 50));
  }
  async function pushAll(c) {
    const r = registry.get(c.id);
    if (!r) return;
    if (r.teachers.size) {
      const snap = await teacherSnapshot(c);
      r.teachers.forEach(function (ws) { send(ws, { type: 'state', data: snap }); });
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
    if (!C.isLive(c) || !c.endsAt) return;
    const ms = Math.max(0, c.endsAt - Date.now());
    timers.set(c.id, setTimeout(function () {
      C.endRound(c);
      armTimer(c);
      schedule(c);
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

  app.get('/healthz', function (req, res) { res.json({ ok: true, livekit: lkReady }); });

  app.get('/vendor/livekit-client.umd.js', function (req, res) {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(LK_CLIENT);
  });

  app.get('/', function (req, res) { res.sendFile(path.join(PUBLIC, 'index.html')); });
  app.get('/aula/:id', function (req, res) { res.sendFile(path.join(PUBLIC, 'aluno.html')); });
  app.get(['/professor', '/professor/:id'], function (req, res) { res.sendFile(path.join(PUBLIC, 'professor.html')); });
  app.use(express.static(PUBLIC, { index: false, maxAge: 0 }));

  // --- aluno ---
  app.get('/api/classes/:id/public', function (req, res) {
    const c = getClass(req.params.id);
    res.json({ title: c.title, phase: c.phase });
  });

  app.post('/api/classes/:id/join', function (req, res) {
    const c = getClass(req.params.id);
    const s = C.joinStudent(c, { name: req.body.name, level: req.body.level, resumeId: req.body.resumeId });
    schedule(c);
    res.json({ studentId: s.id, pid: s.pid, name: s.name, level: s.level });
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
    res.json(await teacherSnapshot(getClass(req.params.id)));
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
        C.startRound(c); armTimer(c); break;
      case 'end-round': C.endRound(c); armTimer(c); break;
      case 'end-class': C.endClass(c); armTimer(c); break;
      case 'hear': C.setHear(c, b.roomId, b.mode); break;
      case 'answer': C.answerCall(c, b.roomId); break;
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
      r.teachers.add(ws);
      ws.on('close', function () { r.teachers.delete(ws); });
      teacherSnapshot(c).then(function (snap) { send(ws, { type: 'state', data: snap }); });
      return;
    }

    const sid = u.searchParams.get('student');
    const s = c.students[sid];
    if (role !== 'student' || !s) { send(ws, { type: 'error', code: 'student', message: 'Entre novamente na aula.' }); ws.close(4003); return; }
    const r = reg(c.id);
    if (!r.students.has(sid)) r.students.set(sid, new Set());
    r.students.get(sid).add(ws);
    C.setOnline(c, sid, true);
    if (C.isLive(c) && !C.roomOf(c, s.pid)) C.placeStudentLive(c, s);
    ws.on('close', function () {
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
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* ignorar */ }
    });
  }, 25000);
  heartbeat.unref();

  function listen(port) {
    load();
    Object.keys(store).forEach(function (id) {
      const c = store[id];
      if (C.isLive(c) && c.endsAt && c.endsAt <= Date.now()) C.endRound(c);
      armTimer(c);
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
