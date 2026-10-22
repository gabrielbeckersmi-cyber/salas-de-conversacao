/* Joguinho da sala de espera: pule os obstáculos. Espaço, seta para cima, clique ou toque. */
(function () {
  'use strict';
  var canvas = document.getElementById('game-canvas');
  if (!canvas) { window.Jogo = { start: function () {}, stop: function () {} }; return; }
  var ctx = canvas.getContext('2d');
  var W = 640, H = 160, GROUND = 128;
  var dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  var scoreEl = document.getElementById('game-score');
  var HI_KEY = 'salas:hi';
  var hi = 0;
  try { hi = Number(localStorage.getItem(HI_KEY)) || 0; } catch (e) { hi = 0; }

  var running = false, raf = 0, last = 0;
  var st = null, col = {};

  function colors() {
    var cs = getComputedStyle(document.documentElement);
    function v(n, d) { return (cs.getPropertyValue(n) || '').trim() || d; }
    col = { ink: v('--ink', '#1a2430'), mute: v('--ink-2', '#5b6773'), bg: v('--surface-2', '#eef1f4'), line: v('--line', '#c9d1d9'), me: v('--primary', '#1d4f91') };
  }
  function reset() {
    st = { y: 0, vy: 0, onGround: true, obs: [], t: 0, dist: 0, speed: 230, next: 1.0, over: false, started: false, hint: true };
  }
  function jump() {
    if (!st) return;
    if (st.over) { if (performance.now() - st.overAtMs > 350) { reset(); st.started = true; st.hint = false; } return; }
    st.started = true; st.hint = false;
    if (st.onGround) { st.vy = 560; st.onGround = false; }
  }
  function step(dt) {
    if (!st.started || st.over) return;
    st.t += dt;
    st.speed = 230 + Math.min(260, st.dist / 12);
    st.dist += st.speed * dt;
    st.vy -= 1750 * dt;
    st.y += st.vy * dt;
    if (st.y <= 0) { st.y = 0; st.vy = 0; st.onGround = true; }
    st.next -= dt;
    if (st.next <= 0) {
      var tall = Math.random() < 0.4;
      st.obs.push({ x: W + 10, w: tall ? 14 : 22, h: tall ? 46 : 28, tall: tall });
      st.next = 0.75 + Math.random() * 0.9 + 120 / st.speed;
    }
    st.obs.forEach(function (o) { o.x -= st.speed * dt; });
    st.obs = st.obs.filter(function (o) { return o.x > -40; });
    // colisão (caixa do jogador um pouco menor que o desenho)
    var px = 52, pw = 26, ph = 30, py = st.y;
    for (var i = 0; i < st.obs.length; i++) {
      var o = st.obs[i];
      if (px + pw - 4 > o.x + 2 && px + 4 < o.x + o.w - 2 && py < o.h - 4) {
        st.over = true; st.overAtMs = performance.now();
        var sc = Math.floor(st.dist / 10);
        if (window.Jogo && window.Jogo.onScore) window.Jogo.onScore(sc);
        if (sc > hi) { hi = sc; try { localStorage.setItem(HI_KEY, String(hi)); } catch (e) { /* ignorar */ } }
      }
    }
  }
  function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = col.bg; ctx.fillRect(0, 0, W, H);
    // chão
    ctx.strokeStyle = col.line; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, GROUND + 1); ctx.lineTo(W, GROUND + 1); ctx.stroke();
    var off = st.dist % 40;
    ctx.fillStyle = col.line;
    for (var x = -off; x < W; x += 40) ctx.fillRect(x, GROUND + 8, 14, 2);
    // obstáculos: lápis
    st.obs.forEach(function (o) {
      var top = GROUND - o.h;
      ctx.fillStyle = col.ink; ctx.fillRect(o.x, top + 8, o.w, o.h - 8);
      ctx.beginPath(); ctx.moveTo(o.x, top + 8); ctx.lineTo(o.x + o.w / 2, top); ctx.lineTo(o.x + o.w, top + 8); ctx.closePath(); ctx.fill();
      ctx.fillStyle = col.bg; ctx.fillRect(o.x + 3, top + 18, o.w - 6, 2);
    });
    // jogador: quadradinho sorridente
    var px = 52, py = GROUND - 30 - st.y;
    ctx.fillStyle = col.me; rr(px, py, 30, 30, 8); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillRect(px + 8, py + 9, 4, 6); ctx.fillRect(px + 19, py + 9, 4, 6);
    if (st.over) { ctx.fillRect(px + 10, py + 22, 10, 2); }
    else { ctx.fillRect(px + 10, py + 21, 10, 2); ctx.fillRect(px + 9, py + 19, 2, 2); ctx.fillRect(px + 19, py + 19, 2, 2); }
    // pernas
    if (st.onGround && st.started && !st.over) {
      var lg = Math.floor(st.dist / 14) % 2;
      ctx.fillStyle = col.me; ctx.fillRect(px + 6 + (lg ? 0 : 8), GROUND - 2, 6, 3); ctx.fillRect(px + 18 - (lg ? 0 : 8), GROUND - 2, 6, 3);
    }
    ctx.fillStyle = col.mute; ctx.font = '700 20px ui-monospace, Menlo, Consolas, monospace'; ctx.textAlign = 'right';
    var sc = Math.floor(st.dist / 10);
    ctx.fillText((hi ? 'HI ' + String(hi).padStart(5, '0') + '   ' : '') + String(sc).padStart(5, '0'), W - 12, 26);
    ctx.textAlign = 'center';
    if (st.hint) ctx.fillText('Toque ou aperte espaço para pular', W / 2, 58);
    if (st.over) { ctx.fillStyle = col.ink; ctx.font = '700 24px ui-sans-serif, system-ui, sans-serif'; ctx.fillText('Fim de jogo. Toque para jogar de novo', W / 2, 70); }
    if (scoreEl) scoreEl.textContent = 'Pontos: ' + sc + (hi ? ' · Recorde: ' + hi : '');
  }
  function loop(ts) {
    if (!running) return;
    if (canvas.offsetParent === null) { running = false; return; } // escondido: pausa
    var dt = Math.min(0.05, (ts - last) / 1000 || 0);
    last = ts;
    step(dt); draw();
    raf = requestAnimationFrame(loop);
  }
  function start() {
    if (running) return;
    if (!st) reset();
    colors();
    running = true; last = performance.now();
    raf = requestAnimationFrame(loop);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('pointerdown', function (e) { e.preventDefault(); jump(); });
  document.addEventListener('keydown', function (e) {
    if (!running) return;
    var t = e.target && e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA' || t === 'BUTTON') return;
    if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); jump(); }
  });
  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else if (canvas.offsetParent !== null) start(); });
  window.Jogo = { start: start, stop: stop };
})();
