/* Funções comuns às páginas do aluno e do professor. */
window.App = (function () {
  'use strict';

  var LEVEL_NAME = { basico: 'Básico', intermediario: 'Intermediário', misto: 'Misto' };
  var LEVEL_CLS = { basico: 'lv-basico', intermediario: 'lv-inter', misto: 'lv-misto' };

  var ICON = {
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    micoff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18"/></svg>',
    cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>',
    head: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
    screen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/></svg>'
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function initials(name) {
    var p = String(name).trim().split(/\s+/);
    return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase();
  }
  function mmss(sec) {
    sec = Math.max(0, Math.ceil(sec));
    return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  }

  function api(method, url, body, token) {
    var headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .catch(function () { var e = new Error('Sem conexão com o servidor. Verifique sua internet.'); e.status = 0; throw e; })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (j) {
          if (!res.ok) {
            var err = new Error((j && j.message) || ('Erro ' + res.status));
            err.status = res.status;
            err.code = j && j.error;
            throw err;
          }
          return j;
        });
      });
  }

  // WebSocket com reconexão automática. Códigos 4001-4004 (login, removido, não encontrado) não reconectam.
  function connectWS(path, h) {
    var ws = null;
    var closed = false;
    var tries = 0;
    var timer = null;
    function open() {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + path);
      ws.onopen = function () { tries = 0; if (h.onOpen) h.onOpen(); };
      ws.onmessage = function (e) {
        var m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        if (h.onMessage) h.onMessage(m);
      };
      ws.onclose = function (e) {
        if (h.onClose) h.onClose(e);
        if (closed || (e.code >= 4001 && e.code <= 4004)) return;
        tries++;
        timer = setTimeout(open, Math.min(8000, 500 * Math.pow(2, Math.min(tries, 4))));
      };
    }
    open();
    return { close: function () { closed = true; clearTimeout(timer); try { ws.close(); } catch (e) { /* ignorar */ } } };
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallback(); });
    }
    return Promise.resolve(fallback());
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  // ---------- tema claro/escuro ----------
  var THEME_KEY = 'salas:theme';
  var SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  function isDark() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function initTheme() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-btn';
    function paint() {
      var d = isDark();
      btn.innerHTML = d ? SUN : MOON;
      btn.title = d ? 'Mudar para o tema claro' : 'Mudar para o tema escuro';
      btn.setAttribute('aria-label', btn.title);
    }
    btn.addEventListener('click', function () {
      var next = isDark() ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignorar */ }
      paint();
      document.dispatchEvent(new CustomEvent('themechange'));
    });
    paint();
    topctl().appendChild(btn);
  }
  var topEl = null;
  function topctl() {
    if (!topEl) { topEl = document.createElement('div'); topEl.className = 'topctl'; document.body.appendChild(topEl); }
    return topEl;
  }
  initTheme();

  return { LEVEL_NAME: LEVEL_NAME, LEVEL_CLS: LEVEL_CLS, ICON: ICON, esc: esc, initials: initials, mmss: mmss, api: api, connectWS: connectWS, copyText: copyText, topctl: topctl };
})();
