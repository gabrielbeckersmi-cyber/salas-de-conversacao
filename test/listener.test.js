const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/classes');

test('ouvinte: entra, é colocado numa sala, some para os alunos e não interage', () => {
  const c = C.createClass({}, { title: 't', roundMinutes: 5 });
  const subs = [];
  for (let i = 0; i < 6; i++) subs.push(C.joinStudent(c, { name: 'Aluno ' + i, level: 'basico' }));
  const ls = C.joinStudent(c, { name: 'Ouvinte', level: 'ouvinte' });
  subs.concat(ls).forEach((s) => { s.online = true; });
  assert.strictEqual(ls.listener, true);
  assert.throws(() => C.joinStudent(c, { name: 'Xavier', level: '' }), /Básico, Intermediário ou Ouvinte/);
  C.startRound(c);
  const room = C.roomOf(c, ls.pid);
  assert.ok(room, 'ouvinte tem sala');
  assert.ok(C.teacherView(c).students.find((s) => s.pid === ls.pid).listener);
  const sv = C.studentView(c, subs[0]);
  sv.room && assert.ok(!sv.room.members.some((m) => m.pid === ls.pid), 'alunos não veem o ouvinte');
  assert.strictEqual(C.studentView(c, ls).me.listener, true);
  assert.throws(() => C.studentSay(c, ls, 'oi'), (e) => e.status === 403 || /ouvinte|listener/i.test(e.message));
  c.rooms.forEach((r) => assert.ok(r.members.filter((p) => !C.byPid(c, p).listener).length <= 4));
});

test('relatório conta quantas vezes o professor foi chamado', () => {
  const R = require('../lib/report');
  const c = C.createClass({}, { title: 't', roundMinutes: 5 });
  const a = C.joinStudent(c, { name: 'Ana', level: 'basico' }); a.online = true;
  const b = C.joinStudent(c, { name: 'Beto', level: 'basico' }); b.online = true;
  C.startRound(c);
  C.setCall(c, a, true); C.setCall(c, a, true);          // repetir o mesmo chamado não conta duas vezes
  const room = C.roomOf(c, a.pid);
  C.answerCall(c, room.id);
  C.setCall(c, a, true); C.setCall(c, a, false);          // chamou e cancelou
  C.setCall(c, b, true);
  const r = R.buildReport(c);
  assert.strictEqual(r.calls.total, 3);
  assert.strictEqual(r.calls.answered, 1 + (room.members.includes(b.pid) ? 1 : 0) * 0);
  assert.strictEqual(r.students.find((s) => s.name === 'Ana').calls, 2);
});
