'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/dinamicas');

function mk(levels) {
  const students = {}; const members = [];
  levels.forEach(function (lv, i) { students['s' + i] = { pid: 'p' + i, name: 'N' + i, level: lv }; members.push('p' + i); });
  return { c: { round: 1, students: students }, room: { id: 'A', members: members } };
}
test('dinâmicas: catálogo tem as 5 e cada uma tem conteúdo', function () {
  const g = D.games('basico');
  assert.deepEqual(g.map(function (x) { return x.id; }).sort(), ['historia', 'impostor', 'leilao', 'mimica', 'quemsou']);
});
test('impostor: só um é impostor e ele não recebe a palavra', function () {
  const { c, room } = mk(['basico', 'basico', 'basico', 'basico']);
  const st = D.stateOf(c, room, Math.random); st.gameId = 'impostor';
  D.act(c, room, 'start', 1);
  const v = room.members.map(function (p) { return D.view(c, room, p, 1); });
  const imp = v.filter(function (x) { return x.impostor; });
  assert.equal(imp.length, 1);
  assert.equal(imp[0].palavra, null);
  v.filter(function (x) { return !x.impostor; }).forEach(function (x) { assert.ok(x.palavra && x.palavra.en); assert.equal(x.palavra.en, v.find(function (y) { return !y.impostor; }).palavra.en); });
  D.act(c, room, 'reveal', 2);
  assert.ok(D.view(c, room, 'p0', 3).nomeImpostor);
});
test('quem sou eu: ninguém vê a própria identidade', function () {
  const { c, room } = mk(['basico', 'basico', 'basico']);
  D.stateOf(c, room).gameId = 'quemsou';
  D.act(c, room, 'start', 1);
  const v0 = D.view(c, room, 'p0', 1);
  assert.equal(v0.outros.length, 2);
  assert.ok(v0.outros.every(function (o) { return o.id && o.id.en; }));
});
test('mímica: cronômetro compartilhado e "de novo" troca as palavras', function () {
  const { c, room } = mk(['basico', 'basico']);
  D.stateOf(c, room).gameId = 'mimica';
  D.act(c, room, 'start', 1);
  D.act(c, room, 'mimica', 1000);
  assert.equal(D.view(c, room, 'p0', 1000).endsAt, 31000);
  assert.equal(D.view(c, room, 'p1', 1000).endsAt, 31000);
  const a = D.view(c, room, 'p0', 1000).palavra.en;
  D.act(c, room, 'again', 2000);
  assert.notEqual(D.view(c, room, 'p0', 2000).palavra.en, a);
  assert.equal(D.view(c, room, 'p0', 2000).endsAt, null);
});
test('sortear outra muda o jogo e volta para a explicação; só iniciantes não veem itens de intermediário', function () {
  const { c, room } = mk(['basico', 'basico']);
  const st = D.stateOf(c, room); const g0 = st.gameId;
  D.act(c, room, 'start', 1);
  D.act(c, room, 'next', 2);
  assert.notEqual(st.gameId, g0);
  assert.equal(st.started, false);
  assert.equal(D.view(c, room, 'p0', 2).item, undefined);
  for (let i = 0; i < 30; i++) { st.gameId = 'quemsou'; st.started = false; D.act(c, room, 'start', 1); D.view(c, room, 'p0', 1).outros.forEach(function (o) { assert.ok(o.id.en !== 'Albert Einstein' && o.id.en !== 'Barack Obama'); }); }
});
