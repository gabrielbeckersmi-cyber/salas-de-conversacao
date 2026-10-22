/* Página do aluno: entrar, esperar, conversar na sala de vídeo e chamar o professor. */
(function () {
  'use strict';
  var A = App;
  var LK = window.LivekitClient;
  var $ = function (id) { return document.getElementById(id); };
  // O endereço com o código da aula some da barra assim que a página abre: quem copiar
  // o endereço visível (/aula) não consegue entrar em outro aparelho.
  var classId = location.pathname.split('/').filter(Boolean)[1] || '';
  var LAST = 'salas:last';
  (function remember() {
    var saved = false;
    if (classId) {
      try { localStorage.setItem(LAST, classId); saved = true; } catch (e) { /* ignorar */ }
      try { sessionStorage.setItem(LAST, classId); saved = true; } catch (e) { /* ignorar */ }
      if (saved) { try { history.replaceState(null, '', '/aula'); } catch (e) { /* ignorar */ } }
    } else {
      try { classId = sessionStorage.getItem(LAST) || localStorage.getItem(LAST) || ''; } catch (e) { classId = ''; }
    }
  })();
  var KEY = 'salas:' + classId;
  var screenEl = $('screen');
  var waitingEl = $('waiting');
  var liveEl = $('live');

  var session = null;
  try { session = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { session = null; }
  var publicInfo = null;
  var snap = null;
  var offset = 0;
  var conn = null;

  // ---------- telas simples ----------
  // botão "Sair da aula": fica fixo no topo, ao lado do botão de tema
  var leaveBtn = document.createElement('button');
  leaveBtn.type = 'button';
  leaveBtn.className = 'btn';
  leaveBtn.id = 'leave-btn';
  leaveBtn.textContent = 'Sair da aula';
  leaveBtn.hidden = true;
  A.topctl().insertBefore(leaveBtn, A.topctl().firstChild);
  function showOnly(which) {
    leaveBtn.hidden = which === 'screen';
    screenEl.hidden = which !== 'screen';
    waitingEl.hidden = which !== 'waiting';
    liveEl.hidden = which !== 'live';
  }
  function say(html) { showOnly('screen'); screenEl.innerHTML = html; }
  function screenMessage(title, text) {
    say('<div class="card join"><h1>' + A.esc(title) + '</h1><p>' + A.esc(text) + '</p></div>');
  }

  // ---------- sair e voltar ----------
  function leaveClass() {
    if (conn) { conn.close(); conn = null; }
    leaveLive(); stopCheck(); window.Jogo.stop();
    snap = null;
    say('<div class="card join"><h1>Você saiu da aula</h1><p>Quando quiser, volte para a aula. Você entra na mesma sala em que estava.</p>' +
      '<button class="btn btn-primary" id="j-back" type="button">Voltar para a aula</button></div>');
    $('j-back').addEventListener('click', function () { openSession(); });
  }
  leaveBtn.addEventListener('click', leaveClass);

  function screenEnd(em) {
    var text = em && em.text ? em.text : 'Obrigado por participar! Até a próxima.';
    var btn = '';
    if (em && em.url && /^https?:\/\//i.test(em.url)) {
      btn = '<p><a class="btn btn-primary" href="' + A.esc(em.url) + '" target="_blank" rel="noopener noreferrer">' + A.esc(em.label || 'Abrir link') + '</a></p>';
    }
    say('<div class="card join"><h1>Aula encerrada</h1><p class="endmsg">' + A.esc(text) + '</p>' + btn + '</div>');
  }

  function screenJoin(note) {
    var started = publicInfo && publicInfo.phase !== 'lobby';
    var saved = '';
    try { saved = localStorage.getItem('salas:level') || ''; } catch (e) { saved = ''; }
    var lv = saved === 'intermediario' ? 'intermediario' : 'basico';
    say('<form class="card join" id="join-form" novalidate>' +
      '<h1>' + A.esc(publicInfo ? publicInfo.title : 'Aula de conversação') + '</h1>' +
      (started
        ? '<div class="msg info">Esta aula já começou e não aceita novos alunos. Se você já tinha entrado, digite o mesmo nome para voltar.</div>'
        : '<p>Digite seu nome e escolha o nível em que você se sente mais confortável para conversar.</p>') +
      (note ? '<div class="msg err" role="alert">' + A.esc(note) + '</div>' : '') +
      '<div class="field"><label class="lbl" for="j-name">Seu nome</label><input class="input" id="j-name" maxlength="30" autocomplete="name" placeholder="Ex.: Marcos P." required></div>' +
      '<div class="field"><span class="lbl-t">Seu nível</span><fieldset class="seg" aria-label="Seu nível">' +
      ['basico', 'intermediario'].map(function (l) {
        return '<label class="' + A.LEVEL_CLS[l] + '"><input type="radio" name="level" value="' + l + '"' + (lv === l ? ' checked' : '') + '><span>' + A.LEVEL_NAME[l] + '</span></label>';
      }).join('') + '</fieldset></div>' +
      '<div class="msg err" id="j-err" role="alert" hidden></div>' +
      '<button class="btn btn-primary" id="j-go" type="submit">Entrar na aula</button>' +
      '<p class="small">Depois que a aula começar, novos alunos não conseguem entrar. Entre com antecedência e mantenha esta página aberta.</p>' +
      '</form>');
    var form = $('join-form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('j-name').value.trim();
      var level = form.elements.level.value;
      var err = $('j-err');
      err.hidden = true;
      if (name.length < 2) { err.textContent = 'Digite seu nome (mínimo 2 letras).'; err.hidden = false; $('j-name').focus(); return; }
      $('j-go').disabled = true;
      A.api('POST', '/api/classes/' + classId + '/join', { name: name, level: level, resumeId: session && session.studentId })
        .then(function (r) {
          session = { studentId: r.studentId, pid: r.pid, name: r.name, level: r.level };
          try { localStorage.setItem(KEY, JSON.stringify(session)); localStorage.setItem('salas:level', r.level); } catch (e2) { /* ignorar */ }
          openSession();
        })
        .catch(function (ex) {
          $('j-go').disabled = false;
          err.textContent = ex.message;
          err.hidden = false;
        });
    });
    setTimeout(function () { var n = $('j-name'); if (n) n.focus(); }, 50);
  }

  // ---------- conexão com o servidor da aula ----------
  var netTimer = null;
  function openSession() {
    if (conn) conn.close();
    say('<div class="card join"><p>Conectando à aula…</p></div>');
    conn = A.connectWS('/ws?role=student&class=' + encodeURIComponent(classId) + '&student=' + encodeURIComponent(session.studentId), {
      onOpen: function () { clearTimeout(netTimer); $('net').hidden = true; },
      onMessage: onMessage,
      onClose: function (e) {
        if (e.code === 4003) { // sessão não existe mais no servidor
          session = null;
          try { localStorage.removeItem(KEY); } catch (e2) { /* ignorar */ }
          leaveLive(); stopCheck();
          screenJoin('Não encontramos sua entrada nesta aula. Entre novamente com o mesmo nome.');
        } else if (e.code === 4004) {
          leaveLive(); stopCheck();
          screenMessage('Aula não encontrada', 'Confira o link que o professor enviou.');
        } else if (e.code === 4002) {
          leaveLive(); stopCheck();
          screenMessage('Você foi removido da aula', 'Fale com o professor se isso foi um engano.');
        } else if (snap) {
          // só avisa se a queda durar mais de 3 segundos (oscilações curtas são normais)
          clearTimeout(netTimer);
          netTimer = setTimeout(function () { $('net').hidden = false; }, 3000);
        }
      }
    });
  }

  function onMessage(m) {
    if (m.type === 'state') {
      snap = m.data;
      offset = snap.now - Date.now();
      render();
    } else if (m.type === 'chat') {
      if (snap && snap.room && m.roomId === snap.room.id) addChat(m.msg);
    }
  }

  // ---------- chat da sala ----------
  var chat = { roomId: null, list: [], ids: new Set() };
  var chatOpen = true;
  var chatUnread = 0;
  var chatListEl = $('l-chat-list');
  function chatNearBottom() { return chatListEl.scrollHeight - chatListEl.scrollTop - chatListEl.clientHeight < 60; }
  function chatHTML(m) {
    var mine = snap && snap.me && m.pid === snap.me.pid;
    if (m.from === 'professor') return '<div class="cm prof"><span class="who">Professor' + (m.name && m.name !== 'Professor' ? ' · ' + A.esc(m.name) : '') + '</span>' + A.esc(m.text) + '</div>';
    return '<div class="cm' + (mine ? ' me' : '') + '"><span class="who">' + A.esc(mine ? 'Você' : m.name) + '</span>' + A.esc(m.text) + '</div>';
  }
  function renderChat(stick) {
    chatListEl.innerHTML = chat.list.length ? chat.list.map(chatHTML).join('') : '<p class="none">Nenhuma mensagem ainda.</p>';
    if (stick) chatListEl.scrollTop = chatListEl.scrollHeight;
  }
  function paintChatToggle() {
    var b = $('l-chat-toggle');
    $('l-chat-body').hidden = !chatOpen;
    b.setAttribute('aria-expanded', String(chatOpen));
    b.textContent = chatOpen ? 'Esconder chat' : (chatUnread ? 'Mostrar chat · ' + chatUnread + (chatUnread === 1 ? ' nova' : ' novas') : 'Mostrar chat');
    $('l-chat').classList.toggle('chat-new', !chatOpen && chatUnread > 0);
  }
  $('l-chat-toggle').addEventListener('click', function () {
    chatOpen = !chatOpen;
    if (chatOpen) { chatUnread = 0; }
    paintChatToggle();
    if (chatOpen) chatListEl.scrollTop = chatListEl.scrollHeight;
  });
  function addChat(m) {
    if (chat.ids.has(m.id)) return;
    chat.ids.add(m.id);
    chat.list.push(m);
    var mine = snap && m.pid === snap.me.pid;
    if (!chatOpen && !mine) { chatUnread++; paintChatToggle(); }
    var stick = chatNearBottom() || mine;
    renderChat(stick);
  }
  function syncChat() {
    // a chave inclui a rodada: na rodada 2 o chat começa vazio mesmo que o número da sala se repita
    var id = snap && snap.room ? snap.round + ':' + snap.room.id : null;
    if (id === chat.roomId) return;
    chat = { roomId: id, list: [], ids: new Set() };
    chatUnread = 0;
    paintChatToggle();
    renderChat(true);
    if (!id || !session) return;
    A.api('GET', '/api/classes/' + encodeURIComponent(classId) + '/chat?studentId=' + encodeURIComponent(session.studentId)).then(function (r) {
      if (chat.roomId !== id) return;
      r.messages.forEach(function (m) { if (!chat.ids.has(m.id)) { chat.ids.add(m.id); chat.list.push(m); } });
      chat.list.sort(function (a, b) { return a.id - b.id; });
      renderChat(true);
    }, function () { /* ignorar */ });
  }
  $('l-chat-in').addEventListener('focus', function () { var el = this; setTimeout(function () { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* ignorar */ } }, 350); });
  $('l-chat-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var inp = $('l-chat-in');
    var text = inp.value.trim();
    if (!text || !session) return;
    inp.value = '';
    A.api('POST', '/api/classes/' + encodeURIComponent(classId) + '/chat', { studentId: session.studentId, text: text }).catch(function (ex) {
      inp.value = text;
      setWarn(ex.message, false);
      setTimeout(function () { setWarn(null); }, 3000);
    });
  });

  // ---------- câmera do professor (aparece como um quadro a mais na sala) ----------
  function showTeacherCam(track) {
    var t = tiles.get('professor');
    if (!t) {
      var el = document.createElement('div');
      el.className = 'tile teacher has-video';
      el.innerHTML = '<span class="avatar">P</span><video autoplay playsinline></video><span class="nm">Professor</span>';
      t = { el: el, video: el.querySelector('video') };
      tiles.set('professor', t);
      tilesEl.prepend(el);
    }
    track.attach(t.video);
    t.el.classList.add('has-video');
    var p = t.video.play(); if (p && p.catch) p.catch(function () { /* ignorar */ });
  }
  function hideTeacherCam() {
    var t = tiles.get('professor');
    if (t) { t.video.srcObject = null; t.el.remove(); tiles.delete('professor'); }
  }

  // ---------- tela compartilhada pelo professor ----------
  var screenVideo = $('l-screen-video');
  function showScreen(track) {
    track.attach(screenVideo);
    $('l-screen').hidden = false;
    var p = screenVideo.play(); if (p && p.catch) p.catch(function () { /* ignorar */ });
  }
  function hideScreen() {
    setExpanded(false);
    screenVideo.srcObject = null;
    $('l-screen').hidden = true;
  }
  // "Tela cheia" própria (sem a tela cheia do navegador, que no celular pode travar): ocupa a janela toda e tem botão grande para fechar.
  function setExpanded(on) {
    $('l-screen').classList.toggle('expanded', on);
    document.body.classList.toggle('noscroll', on);
    $('l-screen-fs').textContent = on ? 'Fechar tela cheia' : 'Tela cheia';
  }
  $('l-screen-fs').addEventListener('click', function () { setExpanded(!$('l-screen').classList.contains('expanded')); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setExpanded(false); });

  function render() {
    $('title').textContent = snap.title;
    var running = snap.phase === 'r1' || snap.phase === 'r2';
    if (snap.phase === 'done') {
      leaveLive(); stopCheck(); window.Jogo.stop();
      screenEnd(snap.endMessage);
      return;
    }
    if (running && snap.room) {
      stopCheck(); window.Jogo.stop();
      showOnly('live');
      updateLive();
      connectLive(snap.room.lk, snap.room.lkError);
      return;
    }
    leaveLive();
    showOnly('waiting');
    updateWaiting(running);
    window.Jogo.start();
    renderRank();
  }

  // ---------- ranking do joguinho ----------
  function renderRank() {
    var list = (snap && snap.ranking) || [];
    var box = $('game-rank');
    box.hidden = !list.length;
    $('game-rank-list').innerHTML = list.map(function (r) {
      return '<li' + (snap.me && r.pid === snap.me.pid ? ' class="me"' : '') + '><span class="rn">' + A.esc(r.name) + '</span><span class="rs">' + r.score + '</span></li>';
    }).join('');
  }
  window.Jogo.onScore = function (score) {
    if (!session || !score) return;
    A.api('POST', '/api/classes/' + encodeURIComponent(classId) + '/score', { studentId: session.studentId, score: score }).catch(function () { /* ignorar */ });
  };

  // ---------- sala de espera ----------
  function updateWaiting(running) {
    var lvl = A.LEVEL_NAME[snap.me.level];
    if (running) {
      $('w-phase').textContent = 'Rodada em andamento';
      $('w-head').textContent = 'Estamos colocando você em uma sala';
      $('w-sub').textContent = 'O professor vai encaixar você em uma sala em instantes. Mantenha esta página aberta.';
      $('w-note').textContent = '';
    } else if (snap.phase === 'between') {
      $('w-phase').textContent = 'Intervalo';
      $('w-head').textContent = 'Rodada ' + snap.round + ' encerrada';
      $('w-sub').textContent = 'Aguarde o professor iniciar a próxima rodada. Você vai conversar com colegas diferentes.';
      $('w-note').textContent = 'Mantenha esta página aberta.';
    } else {
      $('w-phase').textContent = 'Sala de espera';
      $('w-head').textContent = 'O professor está online e iniciará a aula no horário marcado, aguarde mais alguns instantes.';
      $('w-sub').textContent = 'Pode jogar enquanto espera! Você entrou como ' + snap.me.name + ' (nível ' + lvl + '). ' + snap.waiting.online + (snap.waiting.online === 1 ? ' aluno está' : ' alunos estão') + ' na sala de espera.';
      $('w-note').textContent = 'Quando a aula começar, você entra automaticamente em uma sala com colegas do seu nível. Depois do início, novos alunos não conseguem entrar.';
    }
  }

  // ---------- escolha de câmera e microfone ----------
  var PREF_KEY = 'salas:devices';
  var VIRTUAL = /obs|virtual|manycam|snap camera|xsplit|droidcam|epoccam|ndi|streamlabs/i;
  function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { return {}; } }
  function savePrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { /* ignorar */ } }
  function listDevices() {
    var none = { cams: [], mics: [] };
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve(none);
    return navigator.mediaDevices.enumerateDevices().then(function (ds) {
      return {
        cams: ds.filter(function (d) { return d.kind === 'videoinput' && d.deviceId; }),
        mics: ds.filter(function (d) { return d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'communications'; })
      };
    }, function () { return none; });
  }
  function realCam(list) {
    var real = list.filter(function (d) { return !VIRTUAL.test(d.label); });
    return real.length && real.length < list.length ? real[0] : null;
  }
  // devolve os aparelhos a usar: o que o aluno escolheu antes; senão evita câmera virtual (OBS etc.)
  function bestDevices() {
    return listDevices().then(function (l) {
      var p = loadPrefs();
      var cam = l.cams.some(function (d) { return d.deviceId === p.cam; }) ? p.cam : undefined;
      if (!cam) { var rc = realCam(l.cams); if (rc) cam = rc.deviceId; }
      var mic = l.mics.some(function (d) { return d.deviceId === p.mic; }) ? p.mic : undefined;
      return { cam: cam, mic: mic };
    });
  }
  function fillSelect(sel, list, current, label) {
    sel.innerHTML = '';
    list.forEach(function (d, i) {
      var o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || (label + ' ' + (i + 1));
      if (d.deviceId === current) o.selected = true;
      sel.appendChild(o);
    });
    sel.disabled = !list.length;
  }
  function currentIds(stream) {
    var v = stream && stream.getVideoTracks()[0];
    var a = stream && stream.getAudioTracks()[0];
    return { cam: v && v.getSettings().deviceId, mic: a && a.getSettings().deviceId };
  }

  // teste de câmera e microfone
  var check = null;
  function checkStatus(text, cls) {
    var el = $('w-status');
    el.textContent = text;
    el.className = cls || 'small';
  }
  function startCheck(opts) {
    stopCheck();
    var o = opts || {};
    var pr = loadPrefs();
    var wantCam = o.cam || pr.cam;
    var wantMic = o.mic || pr.mic;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      checkStatus('Este navegador não permite usar a câmera aqui. Abra o link no Chrome ou Safari atualizado.', 'msg err');
      return;
    }
    checkStatus('Pedindo permissão…', 'small');
    navigator.mediaDevices.getUserMedia({
      video: wantCam ? { deviceId: { exact: wantCam } } : true,
      audio: wantMic ? { deviceId: { exact: wantMic } } : true
    }).then(function (stream) {
      var v = $('w-video');
      v.srcObject = stream;
      v.hidden = false;
      v.play().catch(function () { /* ignorar */ });
      var AC = window.AudioContext || window.webkitAudioContext;
      var ctx = null;
      var raf = 0;
      if (AC) {
        ctx = new AC();
        var an = ctx.createAnalyser();
        an.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(an);
        var buf = new Uint8Array(an.fftSize);
        var tick = function () {
          an.getByteTimeDomainData(buf);
          var peak = 0;
          for (var i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
          $('w-meter').style.width = Math.min(100, (peak / 128) * 220) + '%';
          raf = requestAnimationFrame(tick);
          if (check) check.raf = raf;
        };
        tick();
      }
      check = { stream: stream, ctx: ctx, raf: raf };
      $('w-test').textContent = 'Desligar o teste';
      checkStatus('Câmera e microfone funcionando. Fale algo e veja a barra se mexer.', 'msg ok');
      // agora os nomes dos aparelhos estão disponíveis: preenche as listas
      listDevices().then(function (l) {
        if (check && check.stream !== stream) return;
        var ids = currentIds(stream);
        // câmera virtual (OBS...) escolhida automaticamente: tenta uma câmera real
        if (!wantCam && !o.retried) {
          var cur = l.cams.filter(function (d) { return d.deviceId === ids.cam; })[0];
          var rc = realCam(l.cams);
          if (cur && VIRTUAL.test(cur.label) && rc) { startCheck({ cam: rc.deviceId, mic: wantMic, retried: true }); return; }
        }
        fillSelect($('w-cam'), l.cams, ids.cam, 'Câmera');
        fillSelect($('w-mic'), l.mics, ids.mic, 'Microfone');
        $('w-dev').hidden = false;
      });
    }).catch(function (e) {
      if (e && e.name === 'OverconstrainedError' && (wantCam || wantMic)) { savePrefs({}); startCheck({ retried: true }); return; }
      var text = 'Não consegui acessar a câmera e o microfone.';
      if (e && e.name === 'NotAllowedError') text = 'Permissão negada. Toque no cadeado ao lado do endereço, permita câmera e microfone e tente de novo.';
      else if (e && e.name === 'NotFoundError') text = 'Nenhuma câmera ou microfone encontrado neste aparelho.';
      else if (e && e.name === 'NotReadableError') text = 'A câmera ou o microfone está sendo usado por outro aplicativo. Feche-o e tente de novo.';
      checkStatus(text, 'msg err');
    });
  }
  function stopCheck() {
    if (!check) return;
    cancelAnimationFrame(check.raf);
    check.stream.getTracks().forEach(function (t) { t.stop(); });
    if (check.ctx) check.ctx.close().catch(function () { /* ignorar */ });
    check = null;
    var v = $('w-video');
    v.srcObject = null;
    v.hidden = true;
    $('w-meter').style.width = '0';
    $('w-test').textContent = 'Testar câmera e microfone';
  }
  $('w-cam').addEventListener('change', function () { var p = loadPrefs(); p.cam = this.value; savePrefs(p); startCheck({ cam: p.cam, mic: p.mic, retried: true }); });
  $('w-mic').addEventListener('change', function () { var p = loadPrefs(); p.mic = this.value; savePrefs(p); startCheck({ cam: p.cam, mic: p.mic, retried: true }); });
  $('w-test').addEventListener('click', function () { if (check) { stopCheck(); checkStatus('Teste desligado.', 'small'); } else startCheck(); });

  // ---------- sala de vídeo ----------
  var live = null;          // { room, name }
  var connSeq = 0;
  var retryTimer = null;
  var tiles = new Map();    // pid -> { el, video }
  var wake = null;
  var tilesEl = $('l-tiles');
  var audioBox = $('l-audio');

  function setWarn(text, canRetry) {
    $('l-warn').hidden = !text;
    $('l-warn-text').textContent = text || '';
    $('l-retry').hidden = !canRetry;
  }
  function setStatus(text) { $('l-status').textContent = text || ''; }

  function makeTile(pid, name, isMe) {
    var el = document.createElement('div');
    el.className = 'tile ' + A.LEVEL_CLS[snap.me.level] + (isMe ? ' me' : '');
    el.innerHTML = '<span class="avatar">' + A.esc(A.initials(name)) + '</span><video autoplay playsinline' + (isMe ? ' muted' : '') + '></video>' +
      '<span class="nm">' + A.esc(isMe ? name + ' (você)' : name) + '</span><span class="micoff">' + A.ICON.micoff + '</span>';
    return { el: el, video: el.querySelector('video') };
  }
  function getTile(pid, name) {
    var t = tiles.get(pid);
    if (!t) {
      var isMe = snap && pid === snap.me.pid;
      t = makeTile(pid, name || '?', isMe);
      tiles.set(pid, t);
      if (isMe) tilesEl.prepend(t.el); else tilesEl.appendChild(t.el);
    }
    return t;
  }
  function syncTiles() {
    if (!snap || !snap.room) return;
    var want = new Set(snap.room.members.map(function (m) { return m.pid; }));
    tiles.forEach(function (t, pid) { if (pid !== 'professor' && !want.has(pid)) { t.el.remove(); tiles.delete(pid); } });
    snap.room.members.forEach(function (m) { getTile(m.pid, m.name); });
  }
  function clearTiles() {
    tiles.forEach(function (t) { t.el.remove(); });
    tiles.clear();
    audioBox.innerHTML = '';
  }

  function muteState(pub, p, muted) {
    var t = tiles.get(p.identity);
    if (!t) return;
    if (pub.kind === 'video') t.el.classList.toggle('video-off', muted);
    if (pub.kind === 'audio') t.el.classList.toggle('mic-off', muted);
  }

  function attachLocalVideo(room) {
    if (!snap) return;
    var pub = room.localParticipant.getTrackPublication(LK.Track.Source.Camera);
    var t = getTile(snap.me.pid, snap.me.name);
    if (pub && pub.track) {
      pub.track.attach(t.video);
      t.el.classList.add('has-video');
      t.el.classList.toggle('video-off', pub.isMuted);
    }
    var mic = room.localParticipant.getTrackPublication(LK.Track.Source.Microphone);
    t.el.classList.toggle('mic-off', !mic || mic.isMuted);
  }

  function updateControls() {
    if (!live) return;
    var lp = live.room.localParticipant;
    var micOn = lp.isMicrophoneEnabled;
    var camOn = lp.isCameraEnabled;
    var mic = $('l-mic');
    var cam = $('l-cam');
    mic.innerHTML = (micOn ? A.ICON.mic : A.ICON.micoff) + (micOn ? 'Microfone ligado' : 'Microfone desligado');
    mic.className = 'btn btn-live';
    mic.setAttribute('aria-pressed', String(!micOn));
    cam.innerHTML = A.ICON.cam + (camOn ? 'Câmera ligada' : 'Câmera desligada');
    cam.className = 'btn btn-live';
    cam.setAttribute('aria-pressed', String(!camOn));
  }

  function bindRoom(room, seq) {
    var E = LK.RoomEvent;
    room.on(E.TrackSubscribed, function (track, pub, p) {
      if (seq !== connSeq) return;
      if (track.kind === 'audio') {
        audioBox.appendChild(track.attach());
      } else if (track.kind === 'video' && p.identity === 'professor') {
        if (pub.source === LK.Track.Source.ScreenShare) showScreen(track);
        else showTeacherCam(track);
      } else if (track.kind === 'video') {
        var t = getTile(p.identity, p.name);
        track.attach(t.video);
        t.el.classList.add('has-video');
        t.el.classList.toggle('video-off', pub.isMuted);
      }
    });
    room.on(E.TrackUnsubscribed, function (track, pub, p) {
      track.detach().forEach(function (el) { if (el.tagName === 'AUDIO') el.remove(); });
      if (track.kind === 'video' && p.identity === 'professor') {
        if (pub.source === LK.Track.Source.ScreenShare) hideScreen(); else hideTeacherCam();
        return;
      }
      var t = tiles.get(p.identity);
      if (t && track.kind === 'video') t.el.classList.remove('has-video');
    });
    room.on(E.TrackMuted, function (pub, p) { muteState(pub, p, true); });
    room.on(E.TrackUnmuted, function (pub, p) { muteState(pub, p, false); });
    room.on(E.ActiveSpeakersChanged, function (speakers) {
      var ids = new Set(speakers.map(function (s) { return s.identity; }));
      tiles.forEach(function (t, pid) { t.el.classList.toggle('speaking', ids.has(pid)); });
    });
    room.on(E.AudioPlaybackStatusChanged, function () { $('l-sound').hidden = room.canPlaybackAudio; });
    room.on(E.ConnectionStateChanged, function (st) {
      if (seq !== connSeq) return;
      setStatus(st === 'reconnecting' || st === 'signalReconnecting' ? 'Reconectando à sala…' : '');
    });
    room.on(E.LocalTrackPublished, function () { attachLocalVideo(room); updateControls(); });
    room.on(E.Disconnected, function () {
      if (seq !== connSeq || !live || live.room !== room) return;
      live = null;
      setWarn('Você foi desconectado da sala de vídeo. Reconectando…', false);
      retryTimer = setTimeout(function () { if (snap && snap.room && snap.room.lk) startLive(snap.room.lk); }, 2000);
    });
  }

  function connectLive(lk, lkError) {
    if (lkError || !lk) { setWarn(lkError || 'O servidor de vídeo não respondeu. Avise o professor.', false); return; }
    if (live && live.name === lk.room) { syncTiles(); return; }
    startLive(lk);
  }

  function startLive(lk) {
    var seq = ++connSeq;
    clearTimeout(retryTimer);
    if (live) { var old = live.room; live = null; try { old.disconnect(); } catch (e) { /* ignorar */ } }
    clearTiles();
    hideScreen();
    return bestDevices().then(function (d) {
      if (seq !== connSeq) return;
      return startLiveWith(lk, seq, d);
    });
  }
  function startLiveWith(lk, seq, d) {
    var vdef = { resolution: { width: 640, height: 360, frameRate: 24 } };
    if (d.cam) vdef.deviceId = d.cam;
    var adef = {};
    if (d.mic) adef.deviceId = d.mic;
    var room = new LK.Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: vdef,
      audioCaptureDefaults: adef
    });
    live = { room: room, name: lk.room };
    bindRoom(room, seq);
    setWarn(null);
    setStatus('Conectando à sala…');
    syncTiles();
    return room.connect(lk.url, lk.token).then(function () {
      if (seq !== connSeq) { try { room.disconnect(); } catch (e) { /* ignorar */ } return; }
      setStatus('');
      $('l-sound').hidden = room.canPlaybackAudio;
      return enableMedia(room, seq).then(requestWake);
    }, function () {
      if (seq !== connSeq) return;
      live = null;
      setStatus('');
      setWarn('Não consegui entrar na sala de vídeo. Tentando de novo…', false);
      retryTimer = setTimeout(function () { if (snap && snap.room && snap.room.lk) startLive(snap.room.lk); }, 3000);
    });
  }

  function enableMedia(room, seq) {
    var micErr = null;
    var camErr = null;
    return room.localParticipant.setMicrophoneEnabled(true).catch(function (e) { micErr = e; })
      .then(function () { return room.localParticipant.setCameraEnabled(true).catch(function (e) { camErr = e; }); })
      .then(function () {
        if (seq !== connSeq) return;
        attachLocalVideo(room);
        updateControls();
        refreshLiveDevices(room);
        if (micErr || camErr) {
          var what = micErr && camErr ? 'a câmera e o microfone' : (camErr ? 'a câmera' : 'o microfone');
          setWarn('Não consegui usar ' + what + '. Seus colegas não conseguem ' + (micErr && camErr ? 'ver nem ouvir você' : (camErr ? 'ver você' : 'ouvir você')) + '. Toque no cadeado ao lado do endereço, permita o acesso e use “Tentar de novo”.', true);
        } else {
          setWarn(null);
        }
      });
  }

  function refreshLiveDevices(room) {
    listDevices().then(function (l) {
      if (!live || live.room !== room) return;
      var cam = room.getActiveDevice ? room.getActiveDevice('videoinput') : null;
      var mic = room.getActiveDevice ? room.getActiveDevice('audioinput') : null;
      fillSelect($('l-cam-sel'), l.cams, cam, 'Câmera');
      fillSelect($('l-mic-sel'), l.mics, mic, 'Microfone');
      $('l-devs').hidden = !(l.cams.length > 1 || l.mics.length > 1);
    });
  }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', function () { if (live) refreshLiveDevices(live.room); });
  }
  function switchDevice(kind, id) {
    if (!live) return;
    var p = loadPrefs();
    if (kind === 'videoinput') p.cam = id; else p.mic = id;
    savePrefs(p);
    var room = live.room;
    room.switchActiveDevice(kind, id).then(function () { setWarn(null); attachLocalVideo(room); updateControls(); }, function () {
      setWarn('Não consegui trocar ' + (kind === 'videoinput' ? 'de câmera' : 'de microfone') + '. Escolha outra opção da lista.', false);
    });
  }
  $('l-cam-sel').addEventListener('change', function () { switchDevice('videoinput', this.value); });
  $('l-mic-sel').addEventListener('change', function () { switchDevice('audioinput', this.value); });

  function leaveLive() {
    connSeq++;
    clearTimeout(retryTimer);
    if (live) { var r = live.room; live = null; try { r.disconnect(); } catch (e) { /* ignorar */ } }
    clearTiles();
    hideScreen();
    setWarn(null);
    setStatus('');
    releaseWake();
  }

  function requestWake() {
    try {
      if ('wakeLock' in navigator && !wake) {
        navigator.wakeLock.request('screen').then(function (w) { wake = w; w.addEventListener('release', function () { wake = null; }); }, function () { /* ignorar */ });
      }
    } catch (e) { /* ignorar */ }
  }
  function releaseWake() { try { if (wake) wake.release(); } catch (e) { /* ignorar */ } wake = null; }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && live) requestWake(); });

  function updateLive() {
    var r = snap.room;
    $('l-room').textContent = 'Sala ' + r.no;
    $('l-round').textContent = 'Rodada ' + snap.round + ' de 2';
    var b = $('l-banner');
    if (r.hear === 'talk') {
      b.hidden = false; b.className = 'banner talk';
      b.innerHTML = '<span class="pulse"></span>O professor está falando com a sala.';
    } else if (r.hear === 'listen') {
      b.hidden = false; b.className = 'banner listen';
      b.innerHTML = '<span class="eq"><i></i><i></i><i></i></span>O professor está ouvindo a sala.';
    } else {
      b.hidden = true;
    }
    var call = $('l-call');
    call.innerHTML = A.ICON.bell + (r.calling ? 'Chamado enviado' : 'Chamar professor');
    call.disabled = false;
    call.setAttribute('aria-disabled', String(!!r.calling));
    $('l-cancel').hidden = !r.calling;
    syncTiles();
    syncChat();
    tickTimer();
  }

  function tickTimer() {
    if (!snap || !snap.endsAt || liveEl.hidden) return;
    $('l-timer').textContent = A.mmss((snap.endsAt - (Date.now() + offset)) / 1000);
  }
  setInterval(tickTimer, 500);

  // ---------- botões ----------
  function setCall(on) {
    if (!session || !snap || !snap.room) return;
    A.api('POST', '/api/classes/' + classId + '/call', { studentId: session.studentId, on: on })
      .then(function () { snap.room.calling = on; updateLive(); })
      .catch(function (e) { setWarn(e.message, false); });
  }
  $('l-call').addEventListener('click', function () { if (snap && snap.room && !snap.room.calling) setCall(true); });
  $('l-cancel').addEventListener('click', function () { setCall(false); });
  $('l-mic').addEventListener('click', function () {
    if (!live) return;
    var lp = live.room.localParticipant;
    lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled).then(function () { attachLocalVideo(live.room); updateControls(); }, function () { setWarn('Não consegui usar o microfone. Verifique a permissão do navegador.', true); });
  });
  $('l-cam').addEventListener('click', function () {
    if (!live) return;
    var lp = live.room.localParticipant;
    lp.setCameraEnabled(!lp.isCameraEnabled).then(function () { attachLocalVideo(live.room); updateControls(); }, function () { setWarn('Não consegui usar a câmera. Verifique a permissão do navegador.', true); });
  });
  $('l-retry').addEventListener('click', function () { if (live) enableMedia(live.room, connSeq); });
  $('l-sound').addEventListener('click', function () {
    if (live) live.room.startAudio().then(function () { $('l-sound').hidden = live.room.canPlaybackAudio; }, function () { /* ignorar */ });
  });

  // ---------- início ----------
  function init() {
    if (!classId) { screenMessage('Abra pelo link da aula', 'Use o link que o professor enviou (o botão ou a mensagem da aula). O endereço desta página não funciona se for copiado.'); return; }
    A.api('GET', '/api/classes/' + encodeURIComponent(classId) + '/public').then(function (info) {
      publicInfo = info;
      $('title').textContent = info.title;
      if (session) openSession();
      else if (info.phase === 'done') screenEnd(info.endMessage);
      else screenJoin();
    }, function (e) {
      if (e.status === 404) screenMessage('Aula não encontrada', 'Confira o link que o professor enviou.');
      else screenMessage('Sem conexão', e.message);
    });
  }
  init();
})();
