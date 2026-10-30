'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { build } = require('../server');

const SECRET = 'segredo-de-teste-livekit-0123456789abcdef';
const ENV = {
  PORT: '0',
  LIVEKIT_URL: 'wss://exemplo.livekit.cloud',
  LIVEKIT_API_KEY: 'APIkeyTeste',
  LIVEKIT_API_SECRET: SECRET,
  PROFESSOR_PASSWORD: 'senha-do-professor'
};
const DATA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'salas-')), 'classes.json');

function until(fn, ms) {
  const limit = Date.now() + (ms || 4000);
  return new Promise(function (resolve, reject) {
    (function tick() {
      let v;
      try { v = fn(); } catch (e) { v = false; }
      if (v) return resolve(v);
      if (Date.now() > limit) return reject(new Error('tempo esgotado esperando: ' + fn.toString()));
      setTimeout(tick, 25);
    })();
  });
}

function decodeJwt(jwt) {
  const [h, p, s] = jwt.split('.');
  const mac = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64url');
  return { header: JSON.parse(Buffer.from(h, 'base64url')), payload: JSON.parse(Buffer.from(p, 'base64url')), validSignature: mac === s };
}

test('aula completa com 28 alunos', async function (t) {
  let app = build(Object.assign({ DATA_FILE: DATA }, ENV));
  let port = await app.listen(0);
  let base = 'http://127.0.0.1:' + port;

  async function api(method, url, body, token) {
    const res = await fetch(base + url, {
      method: method,
      headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* sem corpo */ }
    return { status: res.status, json: json };
  }

  // --- login do professor ---
  assert.strictEqual((await api('POST', '/api/professor/login', { password: 'errada' })).status, 401);
  const login = await api('POST', '/api/professor/login', { password: ENV.PROFESSOR_PASSWORD });
  assert.strictEqual(login.status, 200);
  const T = login.json.token;
  assert.strictEqual((await api('GET', '/api/professor/classes')).status, 401, 'sem token deve falhar');

  // --- cria a aula ---
  const created = await api('POST', '/api/professor/classes', { title: 'Quinta 23/10', roundMinutes: 15 }, T);
  assert.strictEqual(created.status, 200);
  const CID = created.json.id;
  assert.match(CID, /^[a-z0-9]{10}$/);
  const other = await api('POST', '/api/professor/classes', { title: 'Sexta 24/10' }, T);
  assert.notStrictEqual(other.json.id, CID, 'cada aula tem link diferente');

  const act = (body) => api('POST', '/api/professor/classes/' + CID + '/act', body, T);

  // --- professor conecta ---
  let teacher = null;
  const tws = new WebSocket('ws://127.0.0.1:' + port + '/ws?role=teacher&class=' + CID + '&token=' + encodeURIComponent(T) + '&tid=abc123');
  tws.on('message', (m) => { const j = JSON.parse(m); if (j.type === 'state') teacher = j.data; });
  await until(() => teacher);

  // --- 28 alunos entram (12 básico, 16 intermediário) ---
  const students = [];
  async function openStudent(s) {
    const ctx = { id: s.studentId, pid: s.pid, state: null, ws: null };
    ctx.ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?role=student&class=' + CID + '&student=' + ctx.id);
    ctx.ws.on('message', (m) => { const j = JSON.parse(m); if (j.type === 'state') ctx.state = j.data; });
    ctx.ws.on('close', (code) => { ctx.closed = code; });
    try { await until(() => ctx.state); } catch (e) { throw new Error('aluno ' + s.pid + ' sem estado; ws fechou com ' + ctx.closed + '; total já abertos ' + students.length); }
    return ctx;
  }
  for (let i = 0; i < 28; i++) {
    const level = i < 12 ? 'basico' : 'intermediario';
    const r = await api('POST', '/api/classes/' + CID + '/join', { name: 'Aluno ' + (i + 1), level: level });
    assert.strictEqual(r.status, 200, 'join ' + i);
    students.push(Object.assign(await openStudent(r.json), { name: 'Aluno ' + (i + 1), level: level }));
  }
  await until(() => teacher.students.length === 28 && teacher.students.every((s) => s.online));

  // nome repetido enquanto o outro está online
  const dup = await api('POST', '/api/classes/' + CID + '/join', { name: 'aluno 1', level: 'basico' });
  assert.strictEqual(dup.status, 409);
  // nível inválido
  assert.strictEqual((await api('POST', '/api/classes/' + CID + '/join', { name: 'Fulano', level: 'avancado' })).status, 400);

  // --- sala de espera: ninguém tem sala ainda ---
  assert.strictEqual(students[0].state.phase, 'lobby');
  assert.strictEqual(students[0].state.room, null);
  assert.strictEqual(teacher.rooms.length, 0);

  // --- distribuir automaticamente ---
  assert.strictEqual((await act({ action: 'plan' })).status, 200);
  await until(() => teacher.rooms.length > 0);
  assert.strictEqual(teacher.rooms.length, 8, '12 básico em 4 salas de 3 + 16 intermediário em 4 salas de 4');
  const level = Object.fromEntries(teacher.students.map((s) => [s.pid, s.level]));
  for (const r of teacher.rooms) {
    assert.ok(r.members.length >= 3 && r.members.length <= 4, 'tamanho da sala ' + r.members.length);
    assert.strictEqual(new Set(r.members.map((p) => level[p])).size, 1, 'sala sem misturar níveis');
  }

  // --- professor define 6 salas ---
  await act({ action: 'plan', n: 6 });
  await until(() => teacher.rooms.length === 6);
  assert.strictEqual(teacher.rooms.reduce((n, r) => n + r.members.length, 0), 28);

  // --- criar sala vazia, arrastar aluno, remover sala ---
  await act({ action: 'add-room' });
  await until(() => teacher.rooms.length === 7);
  const extra = teacher.rooms[6];
  const victim = teacher.rooms[0].members[0];
  await act({ action: 'move', pid: victim, roomId: extra.id });
  await until(() => teacher.rooms[6].members.includes(victim));
  assert.strictEqual((await act({ action: 'remove-room', roomId: extra.id })).status, 409, 'sala com aluno não pode ser removida');
  await act({ action: 'move', pid: victim, roomId: teacher.rooms[0].id });
  await until(() => !teacher.rooms[6].members.length);
  assert.strictEqual((await act({ action: 'remove-room', roomId: extra.id })).status, 200);
  await until(() => teacher.rooms.length === 6);

  // --- ainda no lobby, aluno novo pode entrar ---
  const late = await api('POST', '/api/classes/' + CID + '/join', { name: 'Atrasado', level: 'basico' });
  assert.strictEqual(late.status, 200);
  const lateCtx = Object.assign(await openStudent(late.json), { name: 'Atrasado', level: 'basico' });
  students.push(lateCtx);
  await until(() => teacher.students.length === 29);
  await act({ action: 'plan' }); // redistribui com os 29
  await until(() => teacher.rooms.reduce((n, r) => n + r.members.length, 0) === 29);

  // --- iniciar a aula ---
  const roundOneRooms = [];
  assert.strictEqual((await act({ action: 'start' })).status, 200);
  await until(() => teacher.phase === 'r1' && students.every((s) => s.state.phase === 'r1' && s.state.room));
  assert.ok(teacher.endsAt - teacher.now > 14 * 60000 && teacher.endsAt - teacher.now <= 15 * 60000, 'rodada de 15 minutos');
  teacher.rooms.forEach((r) => roundOneRooms.push(r.members.slice()));

  // tokens: sala certa, identidade certa, assinatura válida
  for (const s of students) {
    const lk = s.state.room.lk;
    assert.ok(lk && lk.token, 'aluno recebeu token');
    const j = decodeJwt(lk.token);
    assert.strictEqual(j.header.alg, 'HS256');
    assert.ok(j.validSignature, 'assinatura do token');
    assert.strictEqual(j.payload.sub, s.pid);
    assert.strictEqual(j.payload.iss, ENV.LIVEKIT_API_KEY);
    assert.strictEqual(j.payload.video.room, lk.room);
    assert.strictEqual(j.payload.video.roomJoin, true);
    assert.strictEqual(lk.url, ENV.LIVEKIT_URL);
  }
  const sameRoom = students.filter((s) => s.state.room.id === students[0].state.room.id);
  assert.ok(sameRoom.every((s) => s.state.room.lk.room === students[0].state.room.lk.room), 'colegas na mesma sala LiveKit');
  const otherRoomStudent = students.find((s) => s.state.room.id !== students[0].state.room.id);
  assert.notStrictEqual(otherRoomStudent.state.room.lk.room, students[0].state.room.lk.room, 'salas diferentes, salas LiveKit diferentes');
  for (const r of teacher.rooms) {
    const j = decodeJwt(r.lk.token);
    assert.strictEqual(j.payload.sub, 'prof-abc123', 'cada professor tem identidade própria');
    assert.strictEqual(j.payload.video.room, r.lk.room);
  }

  // --- aluno antigo volta ---
  const back = await api('POST', '/api/classes/' + CID + '/join', { resumeId: students[3].id });
  assert.strictEqual(back.status, 200);
  assert.strictEqual(back.json.pid, students[3].pid);
  // quem caiu e voltou sem o código salvo (mesmo nome) retoma o lugar
  students[5].ws.close();
  await until(() => teacher.students.find((s) => s.pid === students[5].pid).online === false);
  const byName = await api('POST', '/api/classes/' + CID + '/join', { name: students[5].name, level: students[5].level });
  assert.strictEqual(byName.status, 200);
  assert.strictEqual(byName.json.pid, students[5].pid);
  students[5] = Object.assign(await openStudent(byName.json), { name: students[5].name, level: students[5].level });
  await until(() => students[5].state.room);

  // --- chamar professor / atender ---
  const caller = students[8];
  assert.strictEqual((await api('POST', '/api/classes/' + CID + '/call', { studentId: caller.id, on: true })).status, 200);
  await until(() => teacher.students.find((s) => s.pid === caller.pid).callAt);
  await until(() => caller.state.room.calling === true);
  // ouvir e falar: só a sala escolhida fica sabendo
  const callerRoomId = teacher.rooms.find((r) => r.members.includes(caller.pid)).id;
  await act({ action: 'hear', roomId: callerRoomId, mode: 'talk' });
  await act({ action: 'answer', roomId: callerRoomId });
  await until(() => caller.state.room.hear === 'talk' && caller.state.room.calling === false);
  const stranger = students.find((s) => s.state.room.id !== callerRoomId);
  assert.strictEqual(stranger.state.room.hear, null, 'outras salas não sabem');
  assert.ok(!teacher.students.find((s) => s.pid === caller.pid).callAt, 'chamado atendido');

  // --- mover aluno durante a rodada muda a sala do aluno ---
  const mover = students[0];
  const from = mover.state.room.lk.room;
  const targetRoom = teacher.rooms.find((r) => !r.members.includes(mover.pid));
  await act({ action: 'move', pid: mover.pid, roomId: targetRoom.id });
  await until(() => mover.state.room.id === targetRoom.id && mover.state.room.lk.room !== from);
  // volta para a sala original para o resto do teste ficar simples
  await act({ action: 'move', pid: mover.pid, roomId: teacher.rooms.find((r) => roundOneRooms[0].includes(r.members[0]) && r.id !== targetRoom.id)?.id || targetRoom.id });

  // --- fim da rodada 1 -> intervalo com plano da rodada 2 sem repetir parceiros ---
  assert.strictEqual((await act({ action: 'end-round' })).status, 200);
  await until(() => teacher.phase === 'between' && teacher.rooms.length > 0);
  assert.strictEqual(students[1].state.phase, 'between');
  assert.strictEqual(students[1].state.room, null, 'no intervalo ninguém está em sala');
  const met = new Set();
  roundOneRooms.forEach((m) => { for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) met.add([m[i], m[j]].sort().join('|')); });
  let repeated = 0;
  teacher.rooms.forEach((r) => { for (let i = 0; i < r.members.length; i++) for (let j = i + 1; j < r.members.length; j++) if (met.has([r.members[i], r.members[j]].sort().join('|'))) repeated++; });
  assert.strictEqual(repeated, 0, 'rodada 2 sem parceiros repetidos');

  // --- rodada 2 e fim ---
  assert.strictEqual((await act({ action: 'start' })).status, 200);
  await until(() => teacher.phase === 'r2' && students.every((s) => s.state.phase === 'r2' && s.state.room));
  assert.ok(decodeJwt(students[0].state.room.lk.token).payload.video.room.includes('-r2-'), 'sala LiveKit da rodada 2');
  await act({ action: 'end-round' });
  await until(() => teacher.phase === 'closing' && students.every((s) => s.state.phase === 'closing' && !s.state.room && s.state.lobby));
  assert.ok(teacher.endsAt > Date.now(), 'contagem de 5 minutos');
  assert.ok(teacher.lobby && teacher.lobby.token, 'professor recebe a sala de espera');
  await act({ action: 'end-class' });
  await until(() => teacher.phase === 'done' && students.every((s) => s.state.phase === 'done'));
  assert.strictEqual((await api('POST', '/api/classes/' + CID + '/join', { name: 'Tarde demais', level: 'basico' })).json.error, 'done');

  // --- reiniciar o servidor mantém as aulas ---
  app.save(true);
  students.forEach((s) => s.ws.close());
  tws.close();
  await app.close();
  app = build(Object.assign({ DATA_FILE: DATA }, ENV));
  port = await app.listen(0);
  base = 'http://127.0.0.1:' + port;
  const list = await api('GET', '/api/professor/classes', null, T);
  assert.strictEqual(list.json.classes.length, 2);
  const again = await api('GET', '/api/professor/classes/' + CID, null, T);
  assert.strictEqual(again.json.phase, 'done');
  assert.strictEqual(again.json.students.length, 29);
  assert.ok(again.json.students.every((s) => s.online === false));
  await app.close();
});

test('sem LiveKit configurado, iniciar a aula explica o problema', async function () {
  const app = build({ PORT: '0', PROFESSOR_PASSWORD: 'x', DATA_FILE: path.join(os.tmpdir(), 'salas-nada-' + Date.now() + '.json') });
  const port = await app.listen(0);
  const base = 'http://127.0.0.1:' + port;
  const post = (url, body, token) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: token ? 'Bearer ' + token : '' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const tok = (await post('/api/professor/login', { password: 'x' })).json.token;
  const c = (await post('/api/professor/classes', { title: 'T' }, tok)).json;
  await post('/api/classes/' + c.id + '/join', { name: 'Ana', level: 'basico' });
  const r = await post('/api/professor/classes/' + c.id + '/act', { action: 'start' }, tok);
  assert.strictEqual(r.status, 500);
  assert.match(r.json.message, /LiveKit/);
  await app.close();
});
