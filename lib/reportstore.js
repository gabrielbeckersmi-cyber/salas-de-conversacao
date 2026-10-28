'use strict';
// Guarda os relatórios das aulas. Eles ficam fora do arquivo das aulas para sobreviverem à limpeza
// automática e (com Firebase configurado) a novos deploys no Render.
//  - Arquivo (REPORTS_FILE): só sobrevive a deploys se estiver em disco persistente.
//  - Firebase Realtime Database (FIREBASE_DB_URL + FIREBASE_SERVICE_ACCOUNT): sobrevive sempre.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NODE = 'relatoriosSalas';
const SCOPE = 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email';

function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }

function parseAccount(raw) {
  if (!raw) return null;
  let txt = String(raw).trim();
  if (txt[0] !== '{') { try { txt = Buffer.from(txt, 'base64').toString('utf8'); } catch (e) { return null; } }
  try {
    const j = JSON.parse(txt);
    if (j && j.client_email && j.private_key) return { email: j.client_email, key: String(j.private_key).replace(/\\n/g, '\n') };
  } catch (e) { /* ignorar */ }
  return null;
}

class ReportStore {
  constructor(o) {
    const opts = o || {};
    this.file = opts.file || '';
    this.base = String(opts.firebaseUrl || '').replace(/\/$/, '');
    this.account = parseAccount(opts.serviceAccount);
    this.mem = new Map();
    this.timer = null;
    this.tok = null;
    this.lastError = '';
    this.fetchImpl = opts.fetch || fetch;
  }

  get remote() { return !!(this.base && this.account); }
  get mode() { return this.remote ? 'firebase' : 'arquivo'; }

  load() {
    if (!this.file) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      Object.keys(j.reports || {}).forEach((id) => this.mem.set(id, j.reports[id]));
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Não consegui ler', this.file, e.message);
    }
  }

  saveFile(now) {
    if (!this.file) return;
    clearTimeout(this.timer);
    const run = () => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const obj = {};
        this.mem.forEach((v, k) => { obj[k] = v; });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ reports: obj }));
        fs.renameSync(tmp, this.file);
      } catch (e) { console.error('Não consegui salvar os relatórios', e.message); }
    };
    if (now) run(); else { this.timer = setTimeout(run, 500); if (this.timer.unref) this.timer.unref(); }
  }

  async token() {
    if (this.tok && this.tok.exp > Date.now() + 120000) return this.tok.v;
    const iat = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64u(JSON.stringify({ iss: this.account.email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: iat, exp: iat + 3600 }));
    const sig = b64u(crypto.sign('RSA-SHA256', Buffer.from(head + '.' + claim), this.account.key));
    const r = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claim + '.' + sig,
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error('token ' + r.status);
    const j = await r.json();
    this.tok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return this.tok.v;
  }

  async remoteReq(method, suffix, body) {
    const t = await this.token();
    const r = await this.fetchImpl(this.base + '/' + NODE + suffix + '.json?access_token=' + encodeURIComponent(t), {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error('firebase ' + r.status);
    return r.json();
  }

  // grava (memória + arquivo + Firebase). Não lança erro: falha de rede vira lastError.
  async put(report, immediate) {
    this.mem.set(report.id, report);
    this.saveFile(immediate);
    if (this.remote) {
      try { await this.remoteReq('PUT', '/' + encodeURIComponent(report.id), report); this.lastError = ''; }
      catch (e) { this.lastError = e.message; console.error('Relatório não foi para o Firebase:', e.message); }
    }
  }

  async get(id) {
    const key = String(id || '');
    if (!/^[a-z0-9]{4,40}$/i.test(key)) return null;
    if (this.remote) {
      try {
        const r = await this.remoteReq('GET', '/' + encodeURIComponent(key));
        if (r) { this.lastError = ''; return r; }
      } catch (e) { this.lastError = e.message; }
    }
    return this.mem.get(key) || null;
  }

  async list() {
    const out = new Map();
    this.mem.forEach((v, k) => out.set(k, v));
    if (this.remote) {
      try {
        const all = await this.remoteReq('GET', '');
        Object.keys(all || {}).forEach((k) => out.set(k, all[k]));
        this.lastError = '';
      } catch (e) { this.lastError = e.message; }
    }
    return Array.from(out.values()).sort((a, b) => (b.startedAt || b.createdAt || 0) - (a.startedAt || a.createdAt || 0));
  }
}

module.exports = { ReportStore, parseAccount };
