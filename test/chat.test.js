const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/classes');

function liveClass(n) {
  const store = {};
  const c = C.createClass(store, { title: 't', roundMinutes: 5 });
  for (let i = 0; i < n; i++) {
    const s = C.joinStudent(c, { name: 'Aluno ' + i, level: i % 2 ? 'basico' : 'intermediario' });
    s.online = true;
  }
  C.startRound(c);
  return c;
}

test('chat por sala, mensagens do professor, microfone e mensagem final', () => {
  const c = liveClass(8);
  const list = Object.values(c.students);
  const room = C.roomOf(c, list[0].pid);
  const other = c.rooms.find((r) => r.id !== room.id);
  const r = C.studentSay(c, list[0], '  oi pessoal  ');
  assert.strictEqual(r.roomId, room.id);
  assert.strictEqual(r.msg.text, 'oi pessoal');
  assert.strictEqual(r.msg.from, 'aluno');
  assert.throws(() => C.studentSay(c, list[0], 'de novo'), /rápido demais/);
  list[0].chatAt = 0;
  assert.throws(() => C.studentSay(c, list[0], '   '), /Digite/);
  assert.strictEqual(C.studentSay(c, list[0], 'x'.repeat(1000)).msg.text.length, 300);

  const t = C.teacherSay(c, [room.id], 'Atenção!', '  Gabriel  ');
  assert.strictEqual(t[0].msg.name, 'Gabriel');
  assert.strictEqual(C.teacherSay(c, [room.id], 'sem nome')[0].msg.name, 'Professor');
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].msg.from, 'professor');
  assert.strictEqual(C.chatHistory(c, room.id).length, 4);
  assert.strictEqual(C.chatHistory(c, other.id).length, 0, 'outra sala não recebe');
  const all = C.teacherSay(c, 'all', 'Para todas');
  assert.strictEqual(all.length, c.rooms.length);
  assert.throws(() => C.teacherSay(c, [], 'x'), /ao menos uma sala/);

  C.setBroadcastMic(c, [other.id, 'inexistente']);
  assert.deepStrictEqual(c.bmic, [other.id]);
  const mate = Object.values(c.students).find((s) => C.roomOf(c, s.pid).id === other.id);
  assert.strictEqual(C.studentView(c, mate).room.hear, 'talk');
  assert.strictEqual(C.studentView(c, list[0]).room.hear, null);

  C.setEndMessage(c, { text: 'Valeu!', url: 'exemplo.com.br/vip', label: 'Quero o curso' });
  assert.deepStrictEqual(c.endMessage, { text: 'Valeu!', url: 'https://exemplo.com.br/vip', label: 'Quero o curso' });
  assert.throws(() => C.setEndMessage(c, { url: 'javascript:alert(1)' }), /link/);
  C.setEndMessage(c, {});
  assert.strictEqual(c.endMessage, null);

  C.endRound(c);
  assert.deepStrictEqual(c.bmic, []);
  C.endRound(c);
  assert.throws(() => C.studentSay(c, list[0], 'oi'), /rodada/);
});

test('nomes que se passam pelo professor são recusados', () => {
  const c = C.createClass({}, { title: 't', roundMinutes: 5 });
  ['Professor', 'professora Ana', 'Prof Carlos', 'Admin'].forEach((n) => assert.throws(() => C.joinStudent(c, { name: n, level: 'basico' }), /não pode ser usado/));
  assert.ok(C.joinStudent(c, { name: 'Profissão Silva', level: 'basico' }));
});
