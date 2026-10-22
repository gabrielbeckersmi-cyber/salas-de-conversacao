const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/classes');

test('ranking do joguinho: top 5, só o melhor de cada aluno, validação', () => {
  const store = {};
  const c = C.createClass(store, { title: 'x', roundMinutes: 15 });
  const ss = [];
  for (let i = 0; i < 7; i++) ss.push(C.joinStudent(c, { name: 'Aluno ' + i, level: 'basico' }).student || Object.values(c.students)[i]);
  const list = Object.values(c.students);
  assert.strictEqual(list.length, 7);
  list.forEach((s, i) => { C.submitScore(c, s, (i + 1) * 100); s.scoreAt = 0; });
  C.submitScore(c, list[0], 50); // pior que o anterior: não troca
  list[0].scoreAt = 0;
  const r = C.ranking(c);
  assert.strictEqual(r.length, 5);
  assert.deepStrictEqual(r.map((x) => x.score), [700, 600, 500, 400, 300]);
  assert.strictEqual(list[0].best, 100);
  assert.throws(() => C.submitScore(c, list[1], -1), /inválida/);
  assert.throws(() => C.submitScore(c, list[1], 99999999), /inválida/);
  assert.throws(() => C.submitScore(c, list[1], 'abc'), /inválida/);
  list[1].scoreAt = Date.now();
  assert.throws(() => C.submitScore(c, list[1], 10), /Calma/);
  assert.strictEqual(C.studentView(c, list[6]).ranking[0].score, 700);
});
