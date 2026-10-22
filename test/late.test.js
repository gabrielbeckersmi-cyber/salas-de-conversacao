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
