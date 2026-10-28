const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/classes');

test('permitir alunos: entrada tardia só quando liberada, cai em Sem sala', () => {
  const store = {};
  const c = C.createClass(store, { title: 't', roundMinutes: 5 });
  for (let i = 0; i < 6; i++) C.joinStudent(c, { name: 'Aluno ' + i, level: 'basico' }).online = true;
  C.startRound(c);
  assert.throws(() => C.joinStudent(c, { name: 'Atrasado', level: 'basico' }), /já começou/);
  C.setAllowLate(c, true);
  const s = C.joinStudent(c, { name: 'Atrasado', level: 'basico' });
  assert.strictEqual(s.late, true);
  assert.ok(!C.roomOf(c, s.pid), 'fica sem sala');
  const room = c.rooms[0];
  C.moveStudent(c, s.pid, room.id);
  assert.strictEqual(C.roomOf(c, s.pid).id, room.id);
  C.setAllowLate(c, false);
  assert.throws(() => C.joinStudent(c, { name: 'Outro', level: 'basico' }), /já começou/);
});

test('mais de 4 por sala à mão; automático respeita 4', () => {
  const store = {};
  const c = C.createClass(store, { title: 't', roundMinutes: 5 });
  for (let i = 0; i < 12; i++) C.joinStudent(c, { name: 'A' + i, level: 'basico' }).online = true;
  C.startRound(c);
  c.rooms.forEach((r) => assert.ok(r.members.length <= 4));
});

test('encerramento: depois da rodada 2 volta para a sala de espera e termina sozinho', () => {
  const c = C.createClass({}, { title: 't', roundMinutes: 5 });
  for (let i = 0; i < 6; i++) C.joinStudent(c, { name: 'A' + i, level: 'basico' }).online = true;
  const t0 = 1000000;
  C.startRound(c, t0);
  assert.strictEqual(c.startedAt, t0);
  C.endRound(c, t0 + 300000);
  assert.strictEqual(c.phase, 'between');
  C.startRound(c, t0 + 400000);
  C.endRound(c, t0 + 700000);
  assert.strictEqual(c.phase, 'closing');
  assert.strictEqual(c.endsAt, t0 + 700000 + C.CLOSING_MINUTES * 60000);
  assert.strictEqual(c.rooms.length, 0);
  C.timeUp(c, c.endsAt);
  assert.strictEqual(c.phase, 'done');
  assert.strictEqual(c.closedBy, 'auto');
  assert.strictEqual(c.endedAt, t0 + 700000 + C.CLOSING_MINUTES * 60000);
  assert.strictEqual(c.rounds.length, 2);
  assert.ok(c.rounds.every((r) => r.endedAt));
  assert.ok(Object.values(c.students).every((s) => s.att && s.att.length === 2));
});

test('chat da sala de espera e registro de problemas', () => {
  const c = C.createClass({}, { title: 't', roundMinutes: 5 });
  const s = C.joinStudent(c, { name: 'Ana', level: 'basico' });
  assert.strictEqual(C.studentSay(c, s, 'oi').roomId, 'lobby');
  const r = C.teacherSay(c, ['lobby'], 'bem-vindos', 'Gabriel');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].roomId, 'lobby');
  assert.strictEqual(C.chatHistory(c, 'lobby').length, 2);
  C.logProblem(c, 'aluno-caiu', 'Ana');
  assert.strictEqual(c.problems.length, 1);
});

test('dois professores conectados recebem identidades diferentes', async () => {
  const { build } = require('../server');
  const WebSocket = require('ws');
  const os = require('os'); const path = require('path');
  const dir = require('fs').mkdtempSync(path.join(os.tmpdir(), 'sc-'));
  const app = build({ PORT: '0', PROFESSOR_PASSWORD: 'pw', LIVEKIT_URL: 'wss://x.livekit.cloud', LIVEKIT_API_KEY: 'APIkey', LIVEKIT_API_SECRET: 's'.repeat(40), DATA_FILE: path.join(dir, 'c.json'), FIREBASE_DB_URL: '' });
  const port = await app.listen(0);
  const base = 'http://127.0.0.1:' + port;
  const j = async (m, u, b, t) => (await fetch(base + u, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: b ? JSON.stringify(b) : undefined })).json();
  const { token } = await j('POST', '/api/professor/login', { password: 'pw' });
  const cls = await j('POST', '/api/professor/classes', { title: 'x' }, token);
  const open = (tid) => new Promise((res) => { const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?role=teacher&class=' + cls.id + '&token=' + encodeURIComponent(token) + '&tid=' + tid); ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'state') res({ ws, m }); }); });
  const a = await open('prof1aa'); const b = await open('prof2bb');
  const sub = (x) => JSON.parse(Buffer.from(x.m.data.lobby.token.split('.')[1], 'base64url').toString()).sub;
  assert.strictEqual(sub(a), 'prof-prof1aa');
  assert.strictEqual(sub(b), 'prof-prof2bb');
  a.ws.close(); b.ws.close();
  await app.close();
});

test('queda de conexão do aluno entra no relatório (e sair pelo botão não)', async () => {
  const { build } = require('../server');
  const WebSocket = require('ws');
  const os = require('os'); const path = require('path');
  const dir = require('fs').mkdtempSync(path.join(os.tmpdir(), 'sc-'));
  const app = build({ PORT: '0', PROFESSOR_PASSWORD: 'pw', LIVEKIT_URL: 'wss://x.livekit.cloud', LIVEKIT_API_KEY: 'APIkey', LIVEKIT_API_SECRET: 's'.repeat(40), DATA_FILE: path.join(dir, 'c.json'), FIREBASE_DB_URL: '' });
  const port = await app.listen(0);
  const base = 'http://127.0.0.1:' + port;
  const j = async (m, u, b, t) => (await fetch(base + u, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: b ? JSON.stringify(b) : undefined })).json();
  const { token } = await j('POST', '/api/professor/login', { password: 'pw' });
  const cls = await j('POST', '/api/professor/classes', { title: 'x' }, token);
  const st = await j('POST', '/api/classes/' + cls.id + '/join', { name: 'Ana', level: 'basico' });
  const open = () => new Promise((res) => { const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?role=student&class=' + cls.id + '&student=' + st.studentId); ws.on('message', () => res(ws)); });
  let ws = await open();
  ws.terminate();
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(app.store[cls.id].problems.length, 1);
  assert.strictEqual(app.store[cls.id].problems[0].kind, 'aluno-caiu');
  ws = await open();
  await j('POST', '/api/classes/' + cls.id + '/leave', { studentId: st.studentId });
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(app.store[cls.id].problems.length, 1, 'sair pelo botão não é problema');
  await j('POST', '/api/classes/' + cls.id + '/problem', { studentId: st.studentId, kind: 'video-falhou' });
  assert.strictEqual(app.store[cls.id].problems.length, 2);
  await app.close();
});
