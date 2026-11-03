'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('../lib/grouping');

function ids(n, p) { return Array.from({ length: n }, (_, i) => (p || 'a') + i); }
function metOf(rooms) {
  const met = new Set();
  rooms.forEach((r) => { for (let i = 0; i < r.members.length; i++) for (let j = i + 1; j < r.members.length; j++) met.add(G.pairKey(r.members[i], r.members[j])); });
  return met;
}

test('salas de 3 a 4 alunos do mesmo nível (5 alunos num nível ficam juntos)', function () {
  for (let n = 6; n <= 60; n++) {
    const r = G.buildRound(ids(n).map((id) => ({ id, level: 'x' })), new Set(), {});
    assert.strictEqual(r.rooms.reduce((s, x) => s + x.members.length, 0), n);
    r.rooms.forEach((x) => assert.ok(x.members.length >= 3 && x.members.length <= 4, n + ' alunos: sala de ' + x.members.length));
  }
  const five = G.buildRound(ids(5).map((id) => ({ id, level: 'x' })), new Set(), {});
  assert.deepStrictEqual(five.rooms.map((x) => x.members.length), [5]);
});

test('nível com menos de 3 alunos entra em salas de outro nível, nunca fica em sala de 1 ou 2', function () {
  const st = ids(9, 'b').map((id) => ({ id, level: 'basico' })).concat(ids(2, 'i').map((id) => ({ id, level: 'inter' })));
  const r = G.buildRound(st, new Set(), {});
  assert.strictEqual(r.rooms.reduce((s, x) => s + x.members.length, 0), 11);
  r.rooms.forEach((x) => assert.ok(x.members.length >= 3, 'sala de ' + x.members.length));
  const only = G.buildRound(ids(2).map((id) => ({ id, level: 'x' })).concat([{ id: 'z', level: 'y' }]), new Set(), {});
  assert.strictEqual(only.rooms.length, 1);
  assert.strictEqual(only.rooms[0].members.length, 3);
});

test('rodada 2 não repete parceiros sempre que for possível', function () {
  // com 3 a 4 por sala, dá para não repetir quando há ao menos 9 alunos (exceto 10 e 11)
  for (let n = 9; n <= 60; n++) {
    if (n === 10 || n === 11) continue;
    for (let t = 0; t < 5; t++) {
      const st = ids(n).map((id) => ({ id, level: 'x' }));
      const r1 = G.buildRound(st, new Set(), {});
      const r2 = G.buildRound(st, metOf(r1.rooms), {});
      assert.strictEqual(r2.repeats, 0, n + ' alunos: ' + r2.repeats + ' pares repetidos');
      r2.rooms.forEach((x) => assert.ok(x.members.length >= 3 && x.members.length <= 4));
    }
  }
});

test('dois níveis e sorteios diferentes: continua sem repetir', function () {
  for (let t = 0; t < 40; t++) {
    const a = 9 + Math.floor(Math.random() * 20), b = 9 + Math.floor(Math.random() * 20);
    const st = ids(a, 'b').map((id) => ({ id, level: 'basico' })).concat(ids(b, 'i').map((id) => ({ id, level: 'inter' })));
    const r1 = G.buildRound(st, new Set(), {});
    const r2 = G.buildRound(st, metOf(r1.rooms), {});
    const bad = [a, b].filter((n) => n === 10 || n === 11).length;
    if (!bad) assert.strictEqual(r2.repeats, 0, a + '+' + b + ' => ' + r2.repeats);
  }
});

test('quando não dá para evitar, repete o mínimo possível', function () {
  const st = ids(10).map((id) => ({ id, level: 'x' }));
  const r1 = G.buildRound(st, new Set(), {});
  const r2 = G.buildRound(st, metOf(r1.rooms), {});
  assert.ok(r2.repeats <= 3, 'repetições: ' + r2.repeats);
});
