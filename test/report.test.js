const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const C = require('../lib/classes');
const R = require('../lib/report');
const { ReportStore } = require('../lib/reportstore');

test('relatório: totais, níveis, rodadas e problemas', () => {
  const c = C.createClass({}, { title: 'Quinta', roundMinutes: 5 });
  ['Ana', 'Beto', 'Caio', 'Duda', 'Edu', 'Fabi'].forEach((n, i) => { C.joinStudent(c, { name: n, level: i < 4 ? 'basico' : 'intermediario' }).online = true; });
  const t0 = 2000000;
  C.startRound(c, t0);
  C.endRound(c, t0 + 1000);
  C.startRound(c, t0 + 2000);
  C.endRound(c, t0 + 3000);
  C.logProblem(c, 'aluno-caiu', 'Ana', t0 + 500);
  C.logProblem(c, 'video-falhou', 'Beto', t0 + 600);
  C.logProblem(c, 'aluno-caiu', 'Caio', t0 + 700);
  C.timeUp(c, c.endsAt);
  const r = R.buildReport(c, 5);
  assert.strictEqual(r.totals.joined, 6);
  assert.strictEqual(r.totals.basico, 4);
  assert.strictEqual(r.totals.intermediario, 2);
  assert.strictEqual(r.totals.attended, 6);
  assert.strictEqual(r.startedAt, t0);
  assert.strictEqual(r.closedBy, 'auto');
  assert.strictEqual(r.rounds.length, 2);
  assert.strictEqual(r.problems.total, 3);
  assert.strictEqual(r.problems.byKind['aluno-caiu'], 2);
  assert.ok(r.students.every((s) => s.rounds.length === 2));
});

test('armazenamento no Firebase com conta de serviço (login JWT, gravar, ler, listar)', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = JSON.stringify({ client_email: 'x@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const db = new Map();
  let tokenCalls = 0;
  const fakeFetch = async (url, opts) => {
    const u = new URL(url);
    if (u.host === 'oauth2.googleapis.com') {
      tokenCalls++;
      const jwt = new URLSearchParams(opts.body).get('assertion');
      const [h, c, s] = jwt.split('.');
      const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + c), publicKey, Buffer.from(s, 'base64url'));
      const claim = JSON.parse(Buffer.from(c, 'base64url').toString());
      assert.ok(ok, 'assinatura RS256 válida');
      assert.strictEqual(claim.iss, 'x@proj.iam.gserviceaccount.com');
      assert.ok(claim.scope.includes('firebase.database'));
      return { ok: true, json: async () => ({ access_token: 'tok123', expires_in: 3600 }) };
    }
    assert.strictEqual(u.searchParams.get('access_token'), 'tok123');
    const key = u.pathname.replace('/relatoriosSalas', '').replace(/^\//, '').replace('.json', '');
    if (opts.method === 'PUT') { db.set(key, JSON.parse(opts.body)); return { ok: true, json: async () => JSON.parse(opts.body) }; }
    if (key) return { ok: true, json: async () => db.get(key) || null };
    const all = {}; db.forEach((v, k) => { all[k] = v; });
    return { ok: true, json: async () => all };
  };
  const store = new ReportStore({ file: '', firebaseUrl: 'https://x.firebaseio.com/', serviceAccount: account, fetch: fakeFetch });
  assert.strictEqual(store.mode, 'firebase');
  await store.put({ id: 'abc123xyz', title: 'T', startedAt: 5 }, true);
  assert.strictEqual(db.get('abc123xyz').title, 'T');
  store.mem.clear(); // como se o servidor tivesse sido reiniciado e perdido tudo
  assert.strictEqual((await store.get('abc123xyz')).title, 'T');
  assert.strictEqual((await store.list()).length, 1);
  assert.strictEqual(tokenCalls, 1, 'token reaproveitado');
  assert.strictEqual(await store.get('../../x'), null, 'id inválido');
});
