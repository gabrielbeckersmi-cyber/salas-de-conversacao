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
  function isProf(id) { return /^prof-/.test(String(id)); }
  // avisa o servidor de problemas de conexão de vídeo (entram no relatório da aula)
  function reportProblem(kind) {
    if (!session) return;
    A.api('POST', '/api/classes/' + encodeURIComponent(classId) + '/problem', { studentId: session.studentId, kind: kind }).catch(function () { /* ignorar */ });
  }
  function watchHealth(room, current) {
    var E = LK.RoomEvent;
    room.on(E.ConnectionStateChanged, function (st) { if (current() && (st === 'reconnecting' || st === 'signalReconnecting')) reportProblem('video-reconectando'); });
    room.on(E.ConnectionQualityChanged, function (q, p) {
      if (current() && p && p === room.localParticipant && (q === 'poor' || q === 'lost')) reportProblem('qualidade-ruim');
    });
  }

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
    document.body.classList.toggle('in-live', which === 'live');
    document.body.classList.toggle('in-wait', which === 'waiting');
    if (which === 'screen') A.urgent(null);
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
  function sendLeave() {
    if (!session) return;
    var url = '/api/classes/' + encodeURIComponent(classId) + '/leave';
    var body = JSON.stringify({ studentId: session.studentId });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
    } catch (e) { /* ignorar */ }
    try { fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }); } catch (e) { /* ignorar */ }
  }
  // fechar a aba ou a página: o professor vê o aluno offline na hora
  window.addEventListener('pagehide', function (ev) { if (!ev.persisted && conn) sendLeave(); });

  function leaveClass() {
    if (conn) { conn.close(); conn = null; }
    sendLeave();
    resetTutorial();
    leaveLive(); leaveLobby(); stopCheck(); window.Jogo.stop();
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

  // ---------- foto de perfil (salva só neste aparelho) ----------
  var PHOTO_KEY = 'salas:photo';
  function getPhoto() { try { return localStorage.getItem(PHOTO_KEY) || ''; } catch (e) { return ''; } }
  function setPhoto(v) { try { if (v) localStorage.setItem(PHOTO_KEY, v); else localStorage.removeItem(PHOTO_KEY); } catch (e) { /* ignorar */ } }
  function resizePhoto(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var side = Math.min(img.width, img.height);
        var c = document.createElement('canvas');
        c.width = c.height = 128;
        c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 128, 128);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Não consegui abrir essa imagem.')); };
      img.src = url;
    });
  }
  function uploadPhoto() {
    var p = getPhoto();
    if (!p || !session) return Promise.resolve();
    return A.api('POST', '/api/classes/' + classId + '/foto', { studentId: session.studentId, photo: p }).catch(function () { /* ignorar */ });
  }
  var PERSON = '<svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor" aria-hidden="true"><circle cx="12" cy="8" r="4.2"/><path d="M3.5 21c0-4.6 3.8-7.5 8.5-7.5s8.5 2.9 8.5 7.5z"/></svg>';
  function paintPhotoPick() {
    var p = getPhoto();
    var c = $('j-photo');
    if (!c) return;
    c.innerHTML = p ? '<img alt="Sua foto" src="' + p + '">' : PERSON;
    $('j-photo-txt').textContent = p ? 'Trocar foto' : 'Adicionar foto';
    $('j-photo-del').hidden = !p;
  }

  function doJoin(name, level) {
    stopPre();
    say('<div class="card join"><p>Entrando…</p></div>');
    A.api('POST', '/api/classes/' + classId + '/join', { name: name, level: level, resumeId: session && session.studentId })
      .then(function (r) {
        session = { studentId: r.studentId, pid: r.pid, name: r.name, level: r.level };
        try { localStorage.setItem(KEY, JSON.stringify(session)); localStorage.setItem('salas:level', r.level); } catch (e2) { /* ignorar */ }
        return uploadPhoto().then(function () { openSession(); });
      })
      .catch(function (ex) { screenJoin(ex.message, { name: name, level: level === 'ouvinte' ? 'ouvinte' : level }); });
  }

  function screenJoin(note, pre) {
    var okListener = false;
    say('<form class="card join" id="join-form" novalidate>' +
      '<div class="photo-pick"><button type="button" class="photo-circle" id="j-photo" aria-label="Adicionar foto"></button>' +
      '<div class="photo-act"><button type="button" class="linkbtn" id="j-photo-txt">Adicionar foto</button><button type="button" class="linkbtn dim" id="j-photo-del" hidden>Remover</button></div>' +
      '<input type="file" id="j-file" accept="image/*" hidden></div>' +
      '<h1>' + A.esc(publicInfo ? publicInfo.title : 'Aula de conversação') + '</h1>' +
      (note ? '<div class="msg err" role="alert">' + A.esc(note) + '</div>' : '') +
      '<div class="field"><label class="lbl" for="j-name">Seu nome</label><input class="input" id="j-name" maxlength="30" autocomplete="name" placeholder="Ex.: Marcos P." required></div>' +
      '<div class="field"><span class="lbl-t">Seu nível</span><fieldset class="seg three" aria-label="Seu nível">' +
      [['basico', 'Básico', A.LEVEL_CLS.basico], ['intermediario', 'Intermediário', A.LEVEL_CLS.intermediario], ['ouvinte', 'Ouvinte', 'lv-ouv']].map(function (l) {
        return '<label class="' + l[2] + '"><input type="radio" name="level" value="' + l[0] + '"><span>' + l[1] + '</span></label>';
      }).join('') + '</fieldset></div>' +
      '<div class="msg err" id="j-err" role="alert" hidden></div>' +
      '<button class="btn btn-primary" id="j-go" type="submit">Continuar</button>' +
      '</form>');
    var form = $('join-form');
    if (pre) {
      $('j-name').value = pre.name || '';
      var rr = form.querySelector('input[value="' + pre.level + '"]');
      if (rr) rr.checked = true;
    }
    paintPhotoPick();
    $('j-photo').addEventListener('click', function () { $('j-file').click(); });
    $('j-photo-txt').addEventListener('click', function () { $('j-file').click(); });
    $('j-photo-del').addEventListener('click', function () { setPhoto(''); paintPhotoPick(); });
    $('j-file').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      resizePhoto(f).then(function (d) { setPhoto(d); paintPhotoPick(); }, function (ex) { var er = $('j-err'); er.textContent = ex.message; er.hidden = false; });
      this.value = '';
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('j-name').value.trim();
      var level = form.elements.level.value;
      var err = $('j-err');
      err.hidden = true;
      if (!level) { err.textContent = 'Escolha o seu nível: Básico, Intermediário ou Ouvinte.'; err.hidden = false; return; }
      if (level === 'ouvinte' && !okListener) { $('ls-modal').hidden = false; return; }
      if (name.length < 2) { err.textContent = 'Digite seu nome (mínimo 2 letras).'; err.hidden = false; $('j-name').focus(); return; }
      if (level === 'ouvinte') doJoin(name, level);      // ouvinte não precisa testar câmera e microfone
      else screenPre(name, level);                       // os outros testam antes de entrar
    });
    form.addEventListener('change', function (e) {
      if (!e.target || e.target.name !== 'level') return;
      okListener = false;
      if (e.target.value === 'ouvinte') $('ls-modal').hidden = false;
    });
    $('ls-cancel').onclick = function () {
      $('ls-modal').hidden = true;
      var r = form.querySelector('input[value=ouvinte]'); if (r) r.checked = false;
      okListener = false;
    };
    $('ls-ok').onclick = function () {
      okListener = true;
      $('ls-modal').hidden = true;
      if ($('j-name').value.trim().length >= 2) form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
      else { $('j-name').focus(); }
    };
    setTimeout(function () { var n = $('j-name'); if (n && !n.value) n.focus(); }, 50);
  }

  // ---------- teste de câmera e microfone antes de entrar ----------
  var preCtl = null;
  function stopPre() { if (preCtl) { preCtl.stop(); preCtl = null; } }
  // ---------- como liberar câmera e microfone, de acordo com o navegador ----------
  function permGuide() {
    var ua = navigator.userAgent || '';
    var ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var android = /Android/i.test(ua);
    var inapp = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|TikTok|musical_ly|Snapchat|Twitter|LinkedInApp|Pinterest|; wv\)/i.test(ua);
    var br = /EdgA|EdgiOS|Edg\//.test(ua) ? 'edge' : /OPR\/|OPiOS|OPT\//.test(ua) ? 'opera' : /SamsungBrowser/.test(ua) ? 'samsung' : /FxiOS|Firefox/.test(ua) ? 'firefox' : /CriOS|Chrome\//.test(ua) ? 'chrome' : /Safari/.test(ua) ? 'safari' : 'outro';
    var mac = /Macintosh/.test(ua) && !ios;
    var win = /Windows/.test(ua);
    var name = { edge: 'Microsoft Edge', opera: 'Opera', samsung: 'Samsung Internet', firefox: 'Firefox', chrome: 'Google Chrome', safari: 'Safari', outro: 'seu navegador' }[br];
    var steps;
    if (inapp) {
      return { title: 'Abra a aula no navegador', steps: ['Você abriu o link dentro de outro aplicativo (Instagram, Facebook, TikTok…), que costuma bloquear câmera e microfone.',
        'Toque no menu (⋯ ou ⋮) e escolha "Abrir no navegador", "Abrir no Chrome" ou "Abrir no Safari".', 'Se preferir, copie o link e cole no Chrome (Android) ou no Safari (iPhone).'] };
    }
    if (ios) {
      if (br === 'safari') {
        steps = ['Toque em "aA" no canto esquerdo da barra de endereço.', 'Toque em "Ajustes do Site" (ou "Configurações do Site").', 'Em Câmera e em Microfone, escolha "Permitir".', 'Volte e recarregue a página.',
          'Se não aparecer: abra o app Ajustes do iPhone, toque em Safari (em versões novas: Apps › Safari), depois em Câmera e Microfone e escolha "Perguntar" ou "Permitir".'];
      } else {
        steps = ['Abra o app Ajustes do iPhone.', 'Role até encontrar "' + (br === 'chrome' ? 'Chrome' : br === 'firefox' ? 'Firefox' : br === 'edge' ? 'Edge' : 'o seu navegador') + '" (em versões novas: Apps › ' + (br === 'chrome' ? 'Chrome' : 'o navegador') + ').', 'Ative os botões "Microfone" e "Câmera".', 'Volte para a aula e recarregue a página.',
          'Dica: no iPhone o Safari costuma funcionar melhor para aulas por vídeo.'];
      }
      return { title: 'Como liberar no ' + name + ' (iPhone)', steps: steps };
    }
    if (android) {
      var sys = 'Se ainda não funcionar: Configurações do Android › Apps › ' + name + ' › Permissões › Câmera e Microfone › "Permitir somente com o app em uso".';
      if (br === 'samsung') steps = ['Toque no ícone à esquerda do endereço (cadeado) e depois em "Permissões".', 'Ative Câmera e Microfone.', 'Se não aparecer: toque no menu ≡ › Configurações › Sites e downloads › Permissões do site › Câmera / Microfone, e permita este site.', 'Recarregue a página.', sys];
      else if (br === 'firefox') steps = ['Toque no cadeado à esquerda do endereço.', 'Toque em "Permissões do site" (ou "Editar configurações do site").', 'Em Câmera e Microfone, escolha "Permitir".', 'Recarregue a página.', sys];
      else if (br === 'edge') steps = ['Toque no cadeado à esquerda do endereço e depois em "Permissões".', 'Em Câmera e Microfone, escolha "Permitir".', 'Recarregue a página.', sys];
      else steps = ['Toque no ícone à esquerda do endereço (cadeado ou ajustes) e depois em "Permissões".', 'Em Câmera e Microfone, escolha "Permitir".', 'Se não aparecer: toque nos três pontinhos ⋮ › Configurações › Configurações do site › Microfone (e Câmera) e veja se este site está em "Bloqueado".', 'Recarregue a página.', sys];
      return { title: 'Como liberar no ' + name + ' (Android)', steps: steps };
    }
    // computador
    if (br === 'safari' && mac) steps = ['No menu Safari (barra do topo), clique em "Ajustes para Este Site…".', 'Em Câmera e Microfone, escolha "Permitir".', 'Recarregue a página.', 'Se ainda não funcionar: Ajustes do Sistema › Privacidade e Segurança › Câmera e Microfone, e ative o Safari.'];
    else if (br === 'firefox') steps = ['Clique no ícone de permissões à esquerda do endereço.', 'Ao lado de "Bloqueado" (Câmera ou Microfone), clique no X.', 'Recarregue a página e clique em "Permitir" quando o navegador perguntar.'];
    else steps = ['Clique no ícone à esquerda do endereço (cadeado ou ajustes).', 'Em Câmera e em Microfone, mude de "Bloquear" para "Permitir"' + (br === 'edge' ? ' (em "Permissões para este site").' : '.'), 'Clique em "Recarregar" (ou aperte F5).'];
    if (win) steps.push('Se ainda não funcionar: Configurações do Windows › Privacidade e segurança › Microfone (e Câmera) e deixe ligado "Permitir que aplicativos acessem".');
    if (br === 'chrome' && !mac) steps.push('Dica: você também pode colar chrome://settings/content/microphone na barra de endereço e remover este site da lista "Bloqueado".');
    return { title: 'Como liberar no ' + name, steps: steps };
  }
  function permGuideHTML() {
    var g = permGuide();
    return '<div class="pre-guide"><h3>' + A.esc(g.title) + '</h3><ol>' + g.steps.map(function (t) { return '<li>' + A.esc(t) + '</li>'; }).join('') + '</ol></div>';
  }

  function screenPre(name, level) {
    stopPre();
    var stream = null, ctx = null, raf = 0, micOk = false, attempts = 0, pop = null, rec = null, testTimer = null, testing = false;
    say('<div class="card join pre">' +
      '<div class="pre-cam"><video id="pre-video" autoplay muted playsinline></video><div class="pre-novideo" id="pre-novideo" hidden>Câmera indisponível</div></div>' +
      '<p class="small pre-help">A câmera não funciona? Tente apertar no botão abaixo e selecionar outra.</p>' +
      '<select class="input" id="pre-cam" aria-label="Escolher câmera"></select>' +
      '<div class="msg err" id="pre-perm" role="alert" hidden><span id="pre-perm-txt"></span> <button class="btn btn-sm" id="pre-perm-btn" type="button">Permitir</button><div id="pre-perm-guide"></div></div>' +
      '<div class="msg err" id="pre-err" role="alert" hidden></div>' +
      '<button class="btn btn-yellow blink" id="pre-mic" type="button">Testar microfone</button>' +
      '<button class="btn" id="pre-go" type="button" disabled>Teste seu microfone antes de entrar</button>' +
      '<button class="linkbtn dim" id="pre-back" type="button">← Voltar</button>' +
      '</div>');

    function closePop() { if (pop) { pop.remove(); pop = null; } }
    function openPop(html) { closePop(); pop = document.createElement('div'); pop.className = 'tut'; pop.innerHTML = '<div class="tut-box pre-pop">' + html + '</div>'; document.body.appendChild(pop); return pop; }
    function stopListen() {
      testing = false;
      clearTimeout(testTimer);
      cancelAnimationFrame(raf);
      if (rec) { try { rec.onresult = rec.onerror = rec.onend = null; rec.abort(); } catch (e) { /* ignorar */ } rec = null; }
      if (ctx) { ctx.close().catch(function () { /* ignorar */ }); ctx = null; }
    }
    function stopStream() {
      stopListen();
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      var v = $('pre-video'); if (v) v.srcObject = null;
    }
    preCtl = { stop: function () { stopStream(); closePop(); } };
    function setErr(t) { var e = $('pre-err'); if (!e) return; e.textContent = t || ''; e.hidden = !t; }
    function paintButtons() {
      var m = $('pre-mic'), g = $('pre-go');
      if (!m || !g) return;
      m.className = 'btn' + (micOk ? '' : ' btn-yellow blink');
      g.disabled = !micOk;
      g.className = 'btn' + (micOk ? ' btn-yellow go-ready' : '');
      g.textContent = micOk ? 'Entrar na aula' : 'Teste seu microfone antes de entrar';
    }
    function showPerm() {
      var q = navigator.permissions && navigator.permissions.query ? navigator.permissions.query({ name: 'microphone' }).then(function (r) { return r.state; }, function () { return 'prompt'; }) : Promise.resolve('prompt');
      q.then(function (st) {
        if (!$('pre-perm')) return;
        var denied = st === 'denied';
        $('pre-perm-txt').textContent = denied
          ? 'O navegador está bloqueando a câmera e o microfone. Siga os passos abaixo e depois toque em "Tentar de novo".'
          : 'Precisamos da sua permissão para usar a câmera e o microfone. Toque no botão e escolha "Permitir".';
        $('pre-perm-guide').innerHTML = permGuideHTML();
        $('pre-perm-btn').textContent = denied ? 'Tentar de novo' : 'Permitir';
        $('pre-perm').hidden = false;
      });
    }
    function fillCams(ids) {
      listDevices().then(function (l) {
        if (!$('pre-cam')) return;
        fillSelect($('pre-cam'), l.cams, ids.cam, 'Câmera');
        var cur = l.cams.filter(function (d) { return d.deviceId === ids.cam; })[0];
        var rc = realCam(l.cams);
        var pr = loadPrefs();
        if (!pr.cam && cur && VIRTUAL.test(cur.label) && rc && !fillCams.retried) { fillCams.retried = true; open({ cam: rc.deviceId }); }
      });
    }
    function onStream(st) {
      stream = st;
      $('pre-perm').hidden = true;
      var v = $('pre-video');
      v.srcObject = st;
      v.play().catch(function () { /* ignorar */ });
      var hasCam = st.getVideoTracks().length > 0;
      $('pre-novideo').hidden = hasCam;
      v.hidden = !hasCam;
      var ids = currentIds(st);
      fillCams(ids);
    }
    function open(o) {
      o = o || {};
      stopStream();
      setErr('');
      var pr = loadPrefs();
      var cam = o.cam !== undefined ? o.cam : pr.cam;
      var mic = o.mic !== undefined ? o.mic : pr.mic;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setErr('Este navegador não permite usar a câmera e o microfone aqui. Abra o link no Chrome ou Safari atualizado.');
        return Promise.resolve();
      }
      var gum = function (c, m, video) {
        return navigator.mediaDevices.getUserMedia({ video: video ? (c ? { deviceId: { exact: c } } : true) : false, audio: m ? { deviceId: { exact: m } } : true });
      };
      return gum(cam, mic, true)
        .catch(function (e) { if (e && e.name === 'OverconstrainedError') { savePrefs({}); return gum(undefined, undefined, true); } throw e; })
        .catch(function (e) {
          // problema só na câmera (não achou ou está em uso): segue só com o microfone
          if (e && (e.name === 'NotFoundError' || e.name === 'NotReadableError' || e.name === 'AbortError')) {
            return gum(undefined, mic, false).then(function (st) {
              setErr(e.name === 'NotReadableError' ? 'A câmera está sendo usada por outro aplicativo. Feche-o e escolha a câmera de novo, ou entre sem câmera.' : 'Não encontrei uma câmera. Você pode entrar sem câmera.');
              return st;
            });
          }
          throw e;
        })
        .then(onStream, function (e) {
          if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) showPerm();
          else if (e && e.name === 'NotFoundError') setErr('Não encontrei microfone neste aparelho.');
          else if (e && e.name === 'NotReadableError') setErr('O microfone está sendo usado por outro aplicativo. Feche-o e tente de novo.');
          else setErr('Não consegui acessar a câmera e o microfone.');
        });
    }
    $('pre-perm-btn').addEventListener('click', function () { open(); });
    $('pre-cam').addEventListener('change', function () {
      var p = loadPrefs(); p.cam = this.value; savePrefs(p);
      open({ cam: p.cam, mic: p.mic });
    });
    $('pre-back').addEventListener('click', function () { stopPre(); screenJoin(null, { name: name, level: level }); });
    $('pre-go').addEventListener('click', function () { if (micOk) doJoin(name, level); });
    $('pre-mic').addEventListener('click', function () { attempts = 0; runTest(); });

    // ----- teste do microfone: fala + reconhecimento de voz grátis do navegador (e medidor de volume como reforço) -----
    function micPerm() {
      return navigator.permissions && navigator.permissions.query ? navigator.permissions.query({ name: 'microphone' }).then(function (r) { return r.state; }, function () { return 'granted'; }) : Promise.resolve('granted');
    }
    function runTest() {
      var track = stream && stream.getAudioTracks()[0];
      if (!track || track.readyState !== 'live') { open().then(function () { if (stream && stream.getAudioTracks()[0]) runTest(); }); return; }
      stopListen();
      testing = true;
      openPop('<h2>Fale algo para testar seu microfone</h2><div class="meter pre-meter" aria-hidden="true"><i id="pp-meter"></i></div><p class="small">Fale normalmente até a barra passar da marca do meio.</p><p class="small" id="pp-heard">&nbsp;</p>');
      var maxLevel = 0, level = 0, sttErr = '', haveAnalyser = false;
      var NEED = 0.08;          // nível mínimo de voz (a marca do meio da barra); ruído de sala fica abaixo disso
      var voiced = 0, firstV = 0, lastV = 0, lastT = 0;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        try {
          ctx = new AC();
          if (ctx.state === 'suspended') ctx.resume();
          var an = ctx.createAnalyser();
          an.fftSize = 512;
          ctx.createMediaStreamSource(new MediaStream([track])).connect(an);
          var buf = new Uint8Array(an.fftSize);
          haveAnalyser = true;
          var tick = function () {
            if (!testing) return;
            an.getByteTimeDomainData(buf);
            var peak = 0;
            for (var i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
            level = Math.max(peak, level * 0.8);   // sobe na hora e desce rápido
            maxLevel = Math.max(maxLevel, level);
            var m = $('pp-meter'); if (m) m.style.width = Math.min(100, level / (NEED * 2) * 100) + '%';
            var now = performance.now();
            var dt = lastT ? Math.min(100, now - lastT) : 0;
            lastT = now;
            if (level > NEED) { voiced += dt; if (!firstV) firstV = now; lastV = now; }
            // fala de verdade: soma pelo menos 0,6 s acima do mínimo, espalhada por 0,8 s ou mais (a fala sobe e desce, então não precisa ser contínua).
            // Um estalo de cabo dura poucos centésimos de segundo e não chega nisso.
            if (voiced >= 600 && lastV - firstV >= 800) { success(); return; }
            raf = requestAnimationFrame(tick);
          };
          tick();
        } catch (e) { haveAnalyser = false; }
      }
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SR) {
        try {
          rec = new SR();
          rec.lang = 'en-US';
          rec.interimResults = true;
          rec.continuous = false;
          rec.onresult = function (ev) {
            var t = '';
            for (var i = ev.resultIndex; i < ev.results.length; i++) t += ev.results[i][0].transcript;
            t = t.trim();
            if (t) { var h = $('pp-heard'); if (h) h.textContent = '“' + t + '”'; if (!haveAnalyser) success(); }   // sem medidor de volume, vale o reconhecimento de voz
          };
          rec.onerror = function (ev) { sttErr = ev && ev.error || ''; };
          rec.start();
        } catch (e) { rec = null; }
      }
      testTimer = setTimeout(function () { if (testing) fail(maxLevel, sttErr); }, 3000);
    }
    function success() {
      if (!testing) return;
      stopListen();
      micOk = true;
      attempts = 0;
      paintButtons();
      openPop('<div class="okpop"><svg viewBox="0 0 52 52" width="72" height="72" aria-hidden="true"><circle cx="26" cy="26" r="24" fill="none" stroke="#2fb457" stroke-width="3"/><path d="M14 27l8 8 16-17" fill="none" stroke="#2fb457" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg><h2>Seu microfone está funcionando!</h2></div>');
      setTimeout(closePop, 1300);
    }
    function fail(maxLevel, sttErr) {
      stopListen();
      var track = stream && stream.getAudioTracks()[0];
      micPerm().then(function (st) {
        var permProblem = st !== 'granted' || !track || track.readyState !== 'live' || sttErr === 'not-allowed' || sttErr === 'service-not-allowed' && maxLevel === 0;
        if (permProblem && (st !== 'granted' || !track || track.readyState !== 'live')) {
          closePop();
          showPerm();
          return;
        }
        attempts++;
        if (attempts >= 3) { showListenerOffer(); return; }
        var blip = maxLevel > 0.08;   // chegou um pico forte, mas não se manteve como voz (estalo, cabo)
        var low = !blip && maxLevel >= 0.03;   // chegou som, mas fraco
        openPop('<h2>' + (blip ? 'Só ouvi um ruído' : low ? 'Som muito baixo' : 'Não consegui ouvir') + '</h2>' +
          (blip ? '<p class="pre-lowmsg">Captei só um ruído rápido, não uma voz. Fale normalmente por alguns segundos e tente de novo.</p>'
          : low ? '<p class="pre-lowmsg">Seu microfone está captando som, mas muito baixo. Fale mais perto do microfone ou mais alto e tente de novo.</p><p>Se continuar baixo, experimente selecionar outro microfone.</p>'
               : '<p>Não consegui ouvir, tente de novo ou experimente selecionar outro microfone</p>') +
          '<div id="pp-micwrap" hidden><select class="input" id="pp-mic" aria-label="Escolher microfone"></select></div>' +
          '<div class="tut-foot"><button class="btn" id="pp-switch" type="button">Trocar de microfone</button><button class="btn btn-primary" id="pp-retry" type="button">Tentar de novo</button></div>');
        $('pp-retry').addEventListener('click', function () { closePop(); runTest(); });
        $('pp-switch').addEventListener('click', function () {
          listDevices().then(function (l) {
            var cur = currentIds(stream).mic;
            fillSelect($('pp-mic'), l.mics, cur, 'Microfone');
            $('pp-micwrap').hidden = false;
            $('pp-switch').hidden = true;
          });
        });
        $('pp-mic').addEventListener('change', function () {
          var p = loadPrefs(); p.mic = this.value; savePrefs(p);
          micOk = false; paintButtons();
          open({ cam: p.cam, mic: p.mic });
        });
      });
    }
    function showListenerOffer() {
      openPop('<h2>Problemas com o microfone?</h2><p>Se o seu microfone está com problemas você pode participar como ouvinte.</p>' +
        '<div class="tut-foot"><button class="btn" id="pp-keep" type="button">Continuar testando microfone</button><button class="btn btn-primary" id="pp-listen" type="button">Participar como ouvinte</button></div>');
      $('pp-keep').addEventListener('click', function () { attempts = 0; closePop(); runTest(); });
      $('pp-listen').addEventListener('click', function () { closePop(); doJoin(name, 'ouvinte'); });
    }

    paintButtons();
    open();
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
          leaveLive(); leaveLobby(); stopCheck();
          screenJoin('Não encontramos sua entrada nesta aula. Entre novamente com o mesmo nome.');
        } else if (e.code === 4004) {
          leaveLive(); leaveLobby(); stopCheck();
          screenMessage('Aula não encontrada', 'Confira o link que o professor enviou.');
        } else if (e.code === 4002) {
          leaveLive(); leaveLobby(); stopCheck();
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
      A.setPhotos(classId, snap.photos);
      offset = snap.now - Date.now();
      render();
      tiles.forEach(function (t, pid) { A.paintAvatar(t.el, pid); });
      lTiles.forEach(function (t, pid) { if (!isProf(pid)) A.paintAvatar(t.el, pid); });
    } else if (m.type === 'dyn') {
      if (snap && snap.room && m.roomId === snap.room.id) dynSet(m.data);
    } else if (m.type === 'mute') {
      if (live && live.room.localParticipant.isMicrophoneEnabled) {
        live.room.localParticipant.setMicrophoneEnabled(false).then(function () { attachLocalVideo(live.room); updateControls(); });
        updateControls({ mic: false });
        setWarn('O professor desligou o seu microfone. Toque em Microfone para ligar de novo.', false);
        setTimeout(function () { if (live) setWarn(null); }, 7000);
      } else if (lobby && lobby.room.localParticipant.isMicrophoneEnabled) {
        lobby.room.localParticipant.setMicrophoneEnabled(false).then(function () { lobbyLocal(lobby.room); lobbyControls(); });
        lobbyControls({ mic: false });
        lobbyWarn('O professor desligou o seu microfone. Toque em Microfone para ligar de novo.');
        setTimeout(function () { lobbyWarn(null); }, 7000);
      }
    } else if (m.type === 'chat') {
      if (m.roomId === 'lobby') addLobbyChat(m.msg);
      else if (snap && snap.room && m.roomId === snap.room.id) addChat(m.msg);
    }
  }

  // ---------- chat da sala ----------
  var chat = { roomId: null, list: [], ids: new Set() };
  var dynSeen = false;        // o aluno já abriu as Dinâmicas?
  var chatUnread = 0;
  var chatTab = 'chat';       // 'chat' | 'tr'
  var trSeen = false;         // o aluno já abriu o tradutor nesta rodada?
  var chatListEl = $('l-chat-list');
  function chatNearBottom() { return chatListEl.scrollHeight - chatListEl.scrollTop - chatListEl.clientHeight < 60; }
  function chatHTML(m) {
    var mine = snap && snap.me && m.pid === snap.me.pid;
    var say = m.speak ? '<button class="say" type="button" data-say="' + A.esc(m.text) + '" aria-label="Ouvir a pronúncia" title="Ouvir a pronúncia">\uD83D\uDD0A</button>' : '';
    if (m.from === 'professor') return '<div class="cm prof"><span class="who">Professor' + (m.name && m.name !== 'Professor' ? ' · ' + A.esc(m.name) : '') + '</span>' + A.esc(m.text) + say + '</div>';
    return '<div class="cm' + (mine ? ' me' : '') + '"><span class="who">' + A.esc(mine ? 'Você' : m.name) + '</span>' + A.esc(m.text) + say + '</div>';
  }
  function renderChat(stick) {
    chatListEl.innerHTML = chat.list.length ? chat.list.map(chatHTML).join('') : '<p class="none">Nenhuma mensagem ainda.</p>';
    if (stick) chatListEl.scrollTop = chatListEl.scrollHeight;
  }
  function paintChatToggle() {
    $('l-chat').classList.toggle('chat-new', chatUnread > 0 && chatTab !== 'chat');
    ['chat', 'tr', 'dyn'].forEach(function (t) {
      $('tab-' + t).classList.toggle('on', chatTab === t);
      $('tab-' + t).setAttribute('aria-selected', String(chatTab === t));
      $('pane-' + t).hidden = chatTab !== t;
    });
    $('tab-tr').classList.toggle('nudge', !trSeen);
    $('tab-dyn').classList.toggle('nudge', !dynSeen);
  }
  function setTab(t) {
    chatTab = t;
    if (t === 'chat') chatUnread = 0; else if (t === 'tr') trSeen = true; else dynSeen = true;
    paintChatToggle();
    if (t === 'chat') chatListEl.scrollTop = chatListEl.scrollHeight;
  }
  $('tab-chat').addEventListener('click', function () { setTab('chat'); });
  $('tab-tr').addEventListener('click', function () { setTab('tr'); });
  $('tab-dyn').addEventListener('click', function () { setTab('dyn'); });
  function addChat(m) {
    if (chat.ids.has(m.id)) return;
    chat.ids.add(m.id);
    chat.list.push(m);
    var mine = snap && m.pid === snap.me.pid;
    if (chatTab !== 'chat' && !mine) { chatUnread++; paintChatToggle(); }
    var stick = chatNearBottom() || mine;
    renderChat(stick);
  }
  function syncChat() {
    // a chave inclui a rodada: na rodada 2 o chat começa vazio mesmo que o número da sala se repita
    var id = snap && snap.room ? snap.round + ':' + snap.room.id : null;
    if (id === chat.roomId) return;
    chat = { roomId: id, list: [], ids: new Set() };
    chatUnread = 0;
    trSeen = false;   // sala nova: o Tradutor e as Dinâmicas voltam a piscar para lembrar dos recursos
    dynSeen = false;
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
  function showTeacherCam(track, id) {
    var key = id || 'prof-x';
    var t = tiles.get(key);
    if (!t) {
      var el = document.createElement('div');
      el.className = 'tile teacher has-video';
      el.innerHTML = '<span class="avatar">P</span><video autoplay playsinline></video><span class="nm">Professor</span>';
      t = { el: el, video: el.querySelector('video') };
      tiles.set(key, t);
      tilesEl.prepend(el);
    }
    track.attach(t.video);
    t.el.classList.add('has-video');
    var p = t.video.play(); if (p && p.catch) p.catch(function () { /* ignorar */ });
  }
  function hideTeacherCam(id) {
    var key = id || 'prof-x';
    var t = tiles.get(key);
    if (t) { t.video.srcObject = null; t.el.remove(); tiles.delete(key); }
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
    var isLs = !!(snap.me && snap.me.listener);
    document.body.classList.toggle('listener', isLs);
    var wls = $('w-ls');
    wls.hidden = !isLs;
    wls.textContent = snap.phase === 'closing' ? 'Você está como ouvinte na sala de espera, ninguém te vê ou te ouve.' : 'Você está como ouvinte na sala de espera, ninguém te vê ou te ouve, a aula já vai começar.';
    $('l-ls').hidden = !isLs;
    var running = snap.phase === 'r1' || snap.phase === 'r2';
    if (snap.phase === 'done') {
      leaveLive(); leaveLobby(); stopCheck(); window.Jogo.stop();
      closeTutorial();
      screenEnd(snap.endMessage);
      return;
    }
    if (running && snap.room) {
      stopCheck(); window.Jogo.stop(); leaveLobby();
      resetTutorial(); closeTutorial();
      showOnly('live');
      updateLive();
      connectLive(snap.room.lk, snap.room.lkError);
      return;
    }
    leaveLive();
    if (snap.phase !== 'lobby' || isLs) closeTutorial();
    showOnly('waiting');
    updateWaiting(running);
    if (!isLs) window.Jogo.start();
    renderRank();
    connectLobby(snap.lobby, snap.lobbyError);
    tickTimer();
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
    $('w-count').hidden = snap.phase !== 'closing';
    $('themes').hidden = !themeItems.length || snap.phase === 'closing';
    if (snap.phase === 'closing') {
      $('w-phase').textContent = '';
      $('w-head').textContent = '';
      $('w-sub').textContent = '';
      $('w-note').textContent = '';
    } else if (running) {
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
      $('w-head').textContent = '';
      $('w-sub').textContent = '';
      $('w-note').textContent = '';
      if (!(snap.me && snap.me.listener)) maybeTutorial();
    }
  }

  // ---------- temas sugeridos (Firebase, via servidor) ----------
  var themeItems = [];
  function loadThemes() {
    fetch('/api/temas').then(function (r) { return r.json(); }).then(function (t) {
      var items = [t.t1, t.t2].filter(Boolean);
      themeItems = items;
      $('themes').hidden = !items.length || !!(snap && snap.phase === 'closing');
      $('themes-list').innerHTML = items.map(function (x) { return '<li>' + A.esc(x) + '</li>'; }).join('');
    }).catch(function () { /* ignorar */ });
  }
  loadThemes();
  setInterval(loadThemes, 60000);

  // ---------- tutorial em vídeo (sala de espera da 1ª rodada) ----------
  var TUT_KEY = 'salas:notut';
  var tutShown = false;
  function isPhone() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 900);
  }
  function maybeTutorial() {
    if (tutShown) return;
    var never = false;
    try { never = localStorage.getItem(TUT_KEY) === '1'; } catch (e) { never = false; }
    if (never) return;
    tutShown = true;
    var url = 'https://www.youtube.com/embed/QZZkQd8JQxY?rel=0&playsinline=1&origin=' + encodeURIComponent(location.origin);
    $('tut-frame').src = url;
    $('tut-link').href = 'https://youtube.com/shorts/QZZkQd8JQxY';
    $('tut').hidden = false;
  }
  function closeTutorial() {
    $('tut').hidden = true;
    $('tut-frame').src = 'about:blank'; // descarrega o player: o vídeo e o áudio param
  }
  $('tut-close').addEventListener('click', function () {
    if ($('tut-never').checked) { try { localStorage.setItem(TUT_KEY, '1'); } catch (e) { /* ignorar */ } }
    closeTutorial();
  });
  // tutShown volta a falso quando o aluno sai da sala de espera da 1ª rodada, para aparecer na próxima entrada
  function resetTutorial() { tutShown = false; }

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
    el.textContent = cls === 'msg err' ? text : ''; // só erros aparecem; o resto fica em silêncio
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
      $('w-meter-box').hidden = false;
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
    $('w-meter-box').hidden = true;
    $('w-test').textContent = 'Testar câmera e microfone';
  }
  $('w-cam').addEventListener('change', function () { var p = loadPrefs(); p.cam = this.value; savePrefs(p); startCheck({ cam: p.cam, mic: p.mic, retried: true }); });
  $('w-mic').addEventListener('change', function () { var p = loadPrefs(); p.mic = this.value; savePrefs(p); startCheck({ cam: p.cam, mic: p.mic, retried: true }); });
  $('w-test').addEventListener('click', function () { if (check) { stopCheck(); checkStatus('Teste desligado.', 'small'); } else { lobbyMediaOff(); startCheck(); } });

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
    el.innerHTML = A.avatar(name, pid) + '<video autoplay playsinline' + (isMe ? ' muted' : '') + '></video>' +
      '<span class="nm">' + A.esc(isMe ? name + ' (você)' : name) + '</span><span class="micoff">' + A.ICON.micoff + '</span>';
    if (isMe) bindFx(el, function () { return live && live.room; }, fxWarnLive);
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
    tiles.forEach(function (t, pid) { if (!isProf(pid) && !want.has(pid)) { t.el.remove(); tiles.delete(pid); } });
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
    keepBlur(room, fxWarnLive);
  }

  // ---------- borrar o fundo da câmera ----------
  var wantBlur = false;
  var FX_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><circle cx="12" cy="9" r="3.4"/><path d="M5.5 20c0-3.6 2.9-5.8 6.5-5.8s6.5 2.2 6.5 5.8z"/><circle cx="4" cy="5" r="1.1" opacity=".55"/><circle cx="20" cy="5" r="1.1" opacity=".55"/><circle cx="3.5" cy="12" r="1.1" opacity=".55"/><circle cx="20.5" cy="12" r="1.1" opacity=".55"/></svg>';
  function loadBlurLib() {
    return new Promise(function (resolve, reject) {
      if (window.LKBlur) { resolve(); return; }
      var sc = document.createElement('script');
      sc.src = '/vendor/blur.js';
      sc.onload = function () { resolve(); };
      sc.onerror = function () { reject(new Error('lib')); };
      document.head.appendChild(sc);
    });
  }
  function camTrackOf(room) {
    var pub = room && room.localParticipant.getTrackPublication(LK.Track.Source.Camera);
    return pub && pub.track ? pub.track : null;
  }
  function applyBlur(room, on) {
    var track = camTrackOf(room);
    if (!track) return Promise.resolve();
    var has = track.getProcessor && track.getProcessor();
    if (!on) return has ? track.stopProcessor() : Promise.resolve();
    if (has) return Promise.resolve();
    return loadBlurLib().then(function () {
      if (!window.LKBlur.supported()) throw new Error('unsupported');
      return track.setProcessor(window.LKBlur.BackgroundProcessor({ mode: 'background-blur', blurRadius: 12 }));
    });
  }
  // reaplica o efeito quando a câmera é ligada de novo ou o aluno troca de sala
  function keepBlur(room, warn) {
    if (!wantBlur) return;
    applyBlur(room, true).catch(function () { wantBlur = false; paintFx(); warn(); });
  }
  function paintFx() {
    document.querySelectorAll('.tile .fxbtn').forEach(function (b) { b.classList.toggle('on', wantBlur); b.setAttribute('aria-pressed', String(wantBlur)); });
  }
  // clicar na própria imagem (com a câmera ligada) mostra o botão do efeito
  function bindFx(el, getRoom, warn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'fxbtn';
    b.title = 'Borrar o fundo';
    b.setAttribute('aria-label', 'Borrar o fundo');
    b.innerHTML = FX_ICON;
    el.appendChild(b);
    var hideT = null;
    el.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.fxbtn')) return;
      el.classList.toggle('fx-open');
      clearTimeout(hideT);
      if (el.classList.contains('fx-open')) hideT = setTimeout(function () { el.classList.remove('fx-open'); }, 5000);
    });
    b.addEventListener('click', function () {
      var room = getRoom();
      if (!room) return;
      wantBlur = !wantBlur;
      paintFx();
      applyBlur(room, wantBlur).catch(function () { wantBlur = false; paintFx(); warn(); });
      clearTimeout(hideT);
      hideT = setTimeout(function () { el.classList.remove('fx-open'); }, 3000);
    });
    paintFx();
  }
  function fxWarnLive() { setWarn('Não consegui borrar o fundo neste aparelho ou navegador.', false); setTimeout(function () { if (live) setWarn(null); }, 6000); }
  function fxWarnLobby() { lobbyWarn('Não consegui borrar o fundo neste aparelho ou navegador.'); setTimeout(function () { lobbyWarn(null); }, 6000); }

  // estado de microfone e câmera que o aluno estava usando: segue com ele entre sala de espera e salas
  var lastMedia = null;
  function applyMedia(room, onErr) {
    var lp = room.localParticipant;
    var m = lastMedia || { mic: false, cam: false };
    var micErr = null, camErr = null;
    return (m.mic ? lp.setMicrophoneEnabled(true).catch(function (e) { micErr = e; }) : Promise.resolve())
      .then(function () { return m.cam ? lp.setCameraEnabled(true).catch(function (e) { camErr = e; }) : null; })
      .then(function () { if (micErr || camErr) onErr(micErr, camErr); });
  }
  function sw(on) { return '<span class="sw' + (on ? ' on' : '') + '" aria-hidden="true"><i></i></span>'; }
  function updateControls(opt) {   // opt: estado que o aluno acabou de pedir; o botão muda na hora, sem esperar o navegador
    if (!live) return;
    var lp = live.room.localParticipant;
    var micOn = opt && opt.mic !== undefined ? opt.mic : lp.isMicrophoneEnabled;
    var camOn = opt && opt.cam !== undefined ? opt.cam : lp.isCameraEnabled;
    lastMedia = { mic: micOn, cam: camOn };
    var mic = $('l-mic');
    var cam = $('l-cam');
    mic.innerHTML = (micOn ? A.ICON.mic : A.ICON.micoff) + 'Microfone' + sw(micOn);
    mic.className = 'btn btn-live';
    mic.setAttribute('aria-pressed', String(!micOn));
    mic.setAttribute('aria-label', micOn ? 'Microfone ligado. Toque para desligar' : 'Microfone desligado. Toque para ligar');
    cam.setAttribute('aria-label', camOn ? 'Câmera ligada. Toque para desligar' : 'Câmera desligada. Toque para ligar');
    cam.innerHTML = A.ICON.cam + 'Câmera' + sw(camOn);
    cam.className = 'btn btn-live';
    cam.setAttribute('aria-pressed', String(!camOn));
  }

  function bindRoom(room, seq) {
    var E = LK.RoomEvent;
    room.on(E.TrackSubscribed, function (track, pub, p) {
      if (seq !== connSeq) return;
      if (track.kind === 'audio') {
        audioBox.appendChild(track.attach());
      } else if (track.kind === 'video' && isProf(p.identity)) {
        if (pub.source === LK.Track.Source.ScreenShare) showScreen(track);
        else showTeacherCam(track, p.identity);
      } else if (track.kind === 'video') {
        var t = getTile(p.identity, p.name);
        track.attach(t.video);
        t.el.classList.add('has-video');
        t.el.classList.toggle('video-off', pub.isMuted);
      }
    });
    room.on(E.TrackUnsubscribed, function (track, pub, p) {
      track.detach().forEach(function (el) { if (el.tagName === 'AUDIO') el.remove(); });
      if (track.kind === 'video' && isProf(p.identity)) {
        if (pub.source === LK.Track.Source.ScreenShare) hideScreen(); else hideTeacherCam(p.identity);
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
      reportProblem('video-caiu');
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
    watchHealth(room, function () { return seq === connSeq && live && live.room === room; });
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
      reportProblem('video-falhou');
      setStatus('');
      setWarn('Não consegui entrar na sala de vídeo. Tentando de novo…', false);
      retryTimer = setTimeout(function () { if (snap && snap.room && snap.room.lk) startLive(snap.room.lk); }, 3000);
    });
  }

  function enableMedia(room, seq) {
    if (snap && snap.me && snap.me.listener) { setWarn(null); return Promise.resolve(); }   // ouvinte não liga câmera nem microfone
    var micErr = null;
    var camErr = null;
    var want = lastMedia || { mic: true, cam: true };   // sem histórico (entrou direto na sala): liga os dois
    return (want.mic ? room.localParticipant.setMicrophoneEnabled(true).catch(function (e) { micErr = e; }) : Promise.resolve())
      .then(function () { return want.cam ? room.localParticipant.setCameraEnabled(true).catch(function (e) { camErr = e; }) : null; })
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
    if (live) {
      var r = live.room; live = null;
      if (lastMedia) lastMedia = { mic: false, cam: lastMedia.cam };   // volta para a sala de espera com o microfone desligado; a câmera fica como estava
      try { r.disconnect(); } catch (e) { /* ignorar */ }
    }
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
    if (r.hear === 'listen') {
      b.hidden = false; b.className = 'banner listen';
      b.innerHTML = '<span class="eq"><i></i><i></i><i></i></span>O professor está ouvindo a sala.';
    } else {
      b.hidden = true;
    }
    var call = $('l-call');
    call.innerHTML = A.ICON.bell + (r.calling ? 'Cancelar chamado' : 'Chamar professor');
    call.disabled = false;
    call.classList.toggle('calling', !!r.calling);
    syncTiles();
    syncChat();
    syncDyn();
    tickTimer();
  }

  function tickTimer() {
    if (!snap || !snap.endsAt) { A.urgent(null); return; }
    var left = (snap.endsAt - (Date.now() + offset)) / 1000;
    if (!liveEl.hidden) {
      $('l-timer').textContent = A.mmss(left);
      A.urgent(A.urgentText(left, 'para o fim da rodada'));
    } else if (!waitingEl.hidden && snap.phase === 'closing') {
      $('w-count-time').textContent = A.mmss(left);
      A.urgent(A.urgentText(left, 'para a aula encerrar'));
    } else {
      A.urgent(null);
    }
  }
  setInterval(tickTimer, 500);

  // ---------- botões ----------
  function setCall(on) {
    if (!session || !snap || !snap.room) return;
    A.api('POST', '/api/classes/' + classId + '/call', { studentId: session.studentId, on: on })
      .then(function () { snap.room.calling = on; updateLive(); })
      .catch(function (e) { setWarn(e.message, false); });
  }
  $('l-call').addEventListener('click', function () { if (snap && snap.room) setCall(!snap.room.calling); });
  $('l-mic').addEventListener('click', function () {
    if (!live) return;
    var lp = live.room.localParticipant;
    var next = !lp.isMicrophoneEnabled;
    updateControls({ mic: next });
    var me = tiles.get(snap.me.pid); if (me) me.el.classList.toggle('mic-off', !next);
    lp.setMicrophoneEnabled(next).then(function () { attachLocalVideo(live.room); updateControls(); }, function () { updateControls(); setWarn('Não consegui usar o microfone. Verifique a permissão do navegador.', true); });
  });
  $('l-cam').addEventListener('click', function () {
    if (!live) return;
    var lp = live.room.localParticipant;
    var next = !lp.isCameraEnabled;
    updateControls({ cam: next });
    if (!next) { var me = tiles.get(snap.me.pid); if (me) me.el.classList.add('video-off'); }
    lp.setCameraEnabled(next).then(function () { attachLocalVideo(live.room); updateControls(); }, function () { updateControls(); setWarn('Não consegui usar a câmera. Verifique a permissão do navegador.', true); });
  });
  $('l-retry').addEventListener('click', function () { if (live) enableMedia(live.room, connSeq); });
  $('l-sound').addEventListener('click', function () {
    if (live) live.room.startAudio().then(function () { $('l-sound').hidden = live.room.canPlaybackAudio; }, function () { /* ignorar */ });
  });

  // ---------- sala de espera em vídeo (todos que estão sem sala se veem e conversam) ----------
  var lobby = null;          // { room, name }
  var lobbySeq = 0;
  var lobbyRetry = null;
  var lTiles = new Map();    // identity -> { el, video }
  var lobbyTilesEl = $('lobby-tiles');
  var lobbyAudio = $('lobby-audio');

  function lobbyWarn(text) { var w = $('lb-warn'); w.hidden = !text; w.textContent = text || ''; }
  // os quadradinhos mudam de tamanho para caber todo mundo no mesmo espaço, sem barra de rolagem
  function fitLobbyTiles() {
    var el = lobbyTilesEl, n = el.children.length;
    if (!n || !el.clientWidth || !el.clientHeight) return;
    var W = el.clientWidth, H = el.clientHeight, gap = 8, best = 0, bc = 1;
    for (var c = 1; c <= n; c++) {
      var rows = Math.ceil(n / c);
      var w = (W - gap * (c - 1)) / c;
      var h = w * 3 / 4;
      if (h * rows + gap * (rows - 1) > H) { h = (H - gap * (rows - 1)) / rows; w = h * 4 / 3; }
      if (w > best) { best = w; bc = c; }
    }
    best = Math.max(40, Math.min(best, 300));
    el.style.gridTemplateColumns = 'repeat(' + bc + ', ' + Math.floor(best) + 'px)';
    el.style.gridAutoRows = Math.floor(best * 3 / 4) + 'px';
  }
  if (window.ResizeObserver) new ResizeObserver(fitLobbyTiles).observe(lobbyTilesEl);
  window.addEventListener('resize', fitLobbyTiles);
  function lobbyCount() { $('lobby-count').textContent = lTiles.size ? '· ' + lTiles.size + (lTiles.size === 1 ? ' pessoa' : ' pessoas') : ''; fitLobbyTiles(); }
  function lobbyTile(id, name) {
    var t = lTiles.get(id);
    if (t) return t;
    var prof = isProf(id);
    var me = !!snap && id === snap.me.pid;
    var el = document.createElement('div');
    el.className = 'tile ' + (prof ? 'teacher lv-misto' : (me ? 'me ' + A.LEVEL_CLS[snap.me.level] : 'lv-misto'));
    var label = prof ? 'Professor' : (me ? (name || snap.me.name) + ' (você)' : (name || '?'));
    el.innerHTML = (prof ? '<span class="avatar">P</span>' : A.avatar(name || '?', id)) + '<video autoplay playsinline' + (me ? ' muted' : '') + '></video>' +
      '<span class="nm">' + A.esc(label) + '</span><span class="micoff">' + A.ICON.micoff + '</span>';
    t = { el: el, video: el.querySelector('video') };
    if (me) bindFx(el, function () { return lobby && lobby.room; }, fxWarnLobby);
    // sem câmera ligada: começa com o ícone de microfone cortado até o aluno falar
    el.classList.add('mic-off');
    lTiles.set(id, t);
    lobbyTilesEl.appendChild(el);
    lobbyCount();
    return t;
  }
  function clearLobbyTiles() {
    lTiles.forEach(function (t) { try { t.video.srcObject = null; } catch (e) { /* ignorar */ } t.el.remove(); });
    lTiles.clear();
    lobbyAudio.innerHTML = '';
    lobbyCount();
  }
  function lobbyMute(pub, p, muted) {
    var t = lTiles.get(p.identity);
    if (!t) return;
    if (pub.kind === 'video') t.el.classList.toggle('video-off', muted);
    if (pub.kind === 'audio') t.el.classList.toggle('mic-off', muted);
  }
  function lobbyLocal(room) {
    if (!snap || snap.me.listener) return;
    var t = lobbyTile(snap.me.pid, snap.me.name);
    var cam = room.localParticipant.getTrackPublication(LK.Track.Source.Camera);
    if (cam && cam.track) { cam.track.attach(t.video); t.el.classList.add('has-video'); t.el.classList.toggle('video-off', cam.isMuted); }
    else t.el.classList.remove('has-video');
    var mic = room.localParticipant.getTrackPublication(LK.Track.Source.Microphone);
    t.el.classList.toggle('mic-off', !mic || mic.isMuted);
    keepBlur(room, fxWarnLobby);
  }
  function lobbyControls(opt) {
    var mic = $('lb-mic');
    var cam = $('lb-cam');
    var lp = lobby && lobby.room.localParticipant;
    var micOn = opt && opt.mic !== undefined ? opt.mic : (!!lp && lp.isMicrophoneEnabled);
    var camOn = opt && opt.cam !== undefined ? opt.cam : (!!lp && lp.isCameraEnabled);
    if (lobby) lastMedia = { mic: micOn, cam: camOn };
    mic.innerHTML = (micOn ? A.ICON.mic : A.ICON.micoff) + 'Microfone' + sw(micOn);
    mic.setAttribute('aria-label', micOn ? 'Microfone ligado. Toque para desligar' : 'Microfone desligado. Toque para ligar');
    cam.setAttribute('aria-label', camOn ? 'Câmera ligada. Toque para desligar' : 'Câmera desligada. Toque para ligar');
    mic.className = 'btn' + (micOn ? ' btn-live' : '');
    mic.setAttribute('aria-pressed', String(micOn));
    cam.innerHTML = A.ICON.cam + 'Câmera' + sw(camOn);
    cam.className = 'btn' + (camOn ? ' btn-live' : '');
    cam.setAttribute('aria-pressed', String(camOn));
    mic.disabled = cam.disabled = !lobby;
  }
  function bindLobby(room, seq) {
    var E = LK.RoomEvent;
    var cur = function () { return seq === lobbySeq; };
    room.on(E.ParticipantConnected, function (p) { if (cur()) lobbyTile(p.identity, p.name); });
    room.on(E.ParticipantDisconnected, function (p) {
      var t = lTiles.get(p.identity);
      if (t) { try { t.video.srcObject = null; } catch (e) { /* ignorar */ } t.el.remove(); lTiles.delete(p.identity); lobbyCount(); }
    });
    room.on(E.TrackSubscribed, function (track, pub, p) {
      if (!cur()) return;
      var t = lobbyTile(p.identity, p.name);
      if (track.kind === 'audio') { lobbyAudio.appendChild(track.attach()); t.el.classList.toggle('mic-off', pub.isMuted); }
      else if (track.kind === 'video') {
        if (isProf(p.identity) && pub.source === LK.Track.Source.ScreenShare) return; // a tela do professor só aparece nas salas
        track.attach(t.video); t.el.classList.add('has-video'); t.el.classList.toggle('video-off', pub.isMuted);
      }
    });
    room.on(E.TrackUnsubscribed, function (track, pub, p) {
      track.detach().forEach(function (el) { if (el.tagName === 'AUDIO') el.remove(); });
      var t = lTiles.get(p.identity);
      if (t && track.kind === 'video') t.el.classList.remove('has-video');
      if (t && track.kind === 'audio') t.el.classList.add('mic-off');
    });
    room.on(E.TrackMuted, function (pub, p) { lobbyMute(pub, p, true); });
    room.on(E.TrackUnmuted, function (pub, p) { lobbyMute(pub, p, false); });
    room.on(E.ActiveSpeakersChanged, function (sp) {
      var ids = new Set(sp.map(function (x) { return x.identity; }));
      lTiles.forEach(function (t, id) { t.el.classList.toggle('speaking', ids.has(id)); });
    });
    room.on(E.AudioPlaybackStatusChanged, function () { $('lb-sound').hidden = room.canPlaybackAudio; });
    room.on(E.LocalTrackPublished, function () { lobbyLocal(room); lobbyControls(); });
    room.on(E.LocalTrackUnpublished, function () { lobbyLocal(room); lobbyControls(); });
    room.on(E.Disconnected, function () {
      if (!cur() || !lobby || lobby.room !== room) return;
      lobby = null;
      reportProblem('video-caiu');
      lobbyControls();
      lobbyRetry = setTimeout(function () { if (snap && snap.lobby && !waitingEl.hidden) startLobby(snap.lobby); }, 2500);
    });
  }
  function connectLobby(lk, err) {
    if (!lk) { if (err) { $('lobby').hidden = false; lobbyWarn('A sala de espera em vídeo não está disponível agora.'); } return; }
    $('lobby').hidden = false;
    if (lobby && lobby.name === lk.room) return;
    startLobby(lk);
  }
  function startLobby(lk) {
    var seq = ++lobbySeq;
    clearTimeout(lobbyRetry);
    if (lobby) { var old = lobby.room; lobby = null; try { old.disconnect(); } catch (e) { /* ignorar */ } }
    clearLobbyTiles();
    lobbyControls();
    return bestDevices().then(function (d) {
      if (seq !== lobbySeq) return;
      var vdef = { resolution: { width: 480, height: 360, frameRate: 15 } };
      if (d.cam) vdef.deviceId = d.cam;
      var adef = {};
      if (d.mic) adef.deviceId = d.mic;
      var room = new LK.Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: vdef,
        audioCaptureDefaults: adef,
        publishDefaults: { videoEncoding: { maxBitrate: 250000, maxFramerate: 15 } }
      });
      bindLobby(room, seq);
      watchHealth(room, function () { return seq === lobbySeq; });
      return room.connect(lk.url, lk.token).then(function () {
        if (seq !== lobbySeq) { try { room.disconnect(); } catch (e) { /* ignorar */ } return; }
        lobby = { room: room, name: lk.room };
        lobbyWarn(null);
        lobbyLocal(room);
        room.remoteParticipants.forEach(function (p) { lobbyTile(p.identity, p.name); });
        $('lb-sound').hidden = room.canPlaybackAudio;
        loadLobbyChat();
        // volta com o mesmo microfone e câmera que o aluno tinha antes
        var rec = lastMedia;
        lastMedia = lastMedia || { mic: false, cam: false };
        return applyMedia(room, function (me, ce) {
          lobbyWarn('Não consegui ligar ' + (me && ce ? 'a câmera e o microfone' : (ce ? 'a câmera' : 'o microfone')) + ' de novo. Toque no botão para tentar outra vez e, se o navegador pedir, escolha Permitir.');
        }).then(function () { if (seq !== lobbySeq) return; lobbyLocal(room); lobbyControls(); });
      }, function () {
        if (seq !== lobbySeq) return;
        reportProblem('video-falhou');
        lobbyWarn('Não consegui entrar na conversa da sala de espera. Tentando de novo…');
        lobbyRetry = setTimeout(function () { if (snap && snap.lobby && !waitingEl.hidden) startLobby(snap.lobby); }, 4000);
      });
    });
  }
  function leaveLobby() {
    lobbySeq++;
    clearTimeout(lobbyRetry);
    if (lobby) { var r = lobby.room; lobby = null; try { r.disconnect(); } catch (e) { /* ignorar */ } }
    clearLobbyTiles();
    lobbyControls();
    $('lobby').hidden = true;
    lobbyWarn(null);
  }
  // câmera e microfone do teste e da sala de espera usam o mesmo aparelho: um desliga o outro
  function lobbyMediaOff() {
    if (!lobby) return;
    var lp = lobby.room.localParticipant;
    lp.setMicrophoneEnabled(false).catch(function () { /* ignorar */ });
    lp.setCameraEnabled(false).catch(function () { /* ignorar */ });
  }
  $('lb-mic').addEventListener('click', function () {
    if (!lobby) return;
    var lp = lobby.room.localParticipant;
    if (!lp.isMicrophoneEnabled) stopCheck();
    var next = !lp.isMicrophoneEnabled;
    lobbyControls({ mic: next });
    var mt = lTiles.get(snap.me.pid); if (mt) mt.el.classList.toggle('mic-off', !next);
    lp.setMicrophoneEnabled(next).then(function () { lobbyLocal(lobby.room); lobbyControls(); lobby.room.startAudio().catch(function () { /* ignorar */ }); },
      function () { lobbyControls(); lobbyWarn('Não consegui usar o microfone. Verifique a permissão do navegador (cadeado ao lado do endereço).'); });
  });
  $('lb-cam').addEventListener('click', function () {
    if (!lobby) return;
    var lp = lobby.room.localParticipant;
    if (!lp.isCameraEnabled) stopCheck();
    var next = !lp.isCameraEnabled;
    lobbyControls({ cam: next });
    if (!next) { var ct = lTiles.get(snap.me.pid); if (ct) ct.el.classList.add('video-off'); }
    lp.setCameraEnabled(next).then(function () { lobbyLocal(lobby.room); lobbyControls(); },
      function () { lobbyControls(); lobbyWarn('Não consegui usar a câmera. Verifique a permissão do navegador (cadeado ao lado do endereço).'); });
  });
  $('lb-sound').addEventListener('click', function () {
    if (lobby) lobby.room.startAudio().then(function () { $('lb-sound').hidden = lobby.room.canPlaybackAudio; }, function () { /* ignorar */ });
  });

  // chat da sala de espera
  var lchat = { list: [], ids: new Set() };
  var lchatEl = $('lb-chat-list');
  function lchatRender(stick) {
    lchatEl.innerHTML = lchat.list.length ? lchat.list.map(chatHTML).join('') : '<p class="none">Diga olá para quem está esperando.</p>';
    if (stick) lchatEl.scrollTop = lchatEl.scrollHeight;
  }
  function addLobbyChat(m) {
    if (lchat.ids.has(m.id)) return;
    lchat.ids.add(m.id);
    lchat.list.push(m);
    var near = lchatEl.scrollHeight - lchatEl.scrollTop - lchatEl.clientHeight < 60;
    lchatRender(near || (snap && m.pid === snap.me.pid));
  }
  function loadLobbyChat() {
    if (!session) return;
    A.api('GET', '/api/classes/' + encodeURIComponent(classId) + '/chat?studentId=' + encodeURIComponent(session.studentId)).then(function (r) {
      (r.lobby || []).forEach(function (m) { if (!lchat.ids.has(m.id)) { lchat.ids.add(m.id); lchat.list.push(m); } });
      lchat.list.sort(function (a, b) { return a.id - b.id; });
      lchatRender(true);
    }, function () { /* ignorar */ });
  }
  lchatRender(false);
  lobbyControls();
  $('lb-chat-toggle').addEventListener('click', function () {
    var box = $('lb-chat'), hide = !box.classList.contains('collapsed');
    box.classList.toggle('collapsed', hide);
    this.textContent = hide ? 'Mostrar' : 'Esconder';
    this.setAttribute('aria-expanded', String(!hide));
    if (!hide) lchatEl.scrollTop = lchatEl.scrollHeight;
  });
  $('lb-chat-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var inp = $('lb-chat-in');
    var text = inp.value.trim();
    if (!text || !session) return;
    inp.value = '';
    A.api('POST', '/api/classes/' + encodeURIComponent(classId) + '/chat', { studentId: session.studentId, text: text }).catch(function (ex) {
      inp.value = text;
      lobbyWarn(ex.message);
      setTimeout(function () { lobbyWarn(null); }, 3000);
    });
  });

  // ---------- tradutor (português <-> inglês) ----------
  var trDir = 'pt-en';
  var trTimer = 0;
  function decodeHtml(t) { var d = document.createElement('textarea'); d.innerHTML = t; return d.value; }
  function trGoogle(text, from, to) {
    return fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + from + '&tl=' + to + '&dt=t&q=' + encodeURIComponent(text))
      .then(function (r) { if (!r.ok) throw new Error('g' + r.status); return r.json(); })
      .then(function (j) { var out = (j && j[0] || []).map(function (x) { return x && x[0] || ''; }).join(''); if (!out) throw new Error('vazio'); return out; });
  }
  function trMyMemory(text, from, to) {
    return fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=' + from + '|' + to)
      .then(function (r) { if (!r.ok) throw new Error('m' + r.status); return r.json(); })
      .then(function (j) {
        var t = j && j.responseData && j.responseData.translatedText;
        if (!t || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(t)) throw new Error('mm');
        return decodeHtml(t);
      });
  }
  function translateText(text, from, to) {
    return trGoogle(text, from, to).catch(function () { return trMyMemory(text, from, to); });
  }
  function trPaint() {
    var pt = trDir === 'pt-en';
    $('tr-from').textContent = pt ? 'Português' : 'Inglês';
    $('tr-to').textContent = pt ? 'Inglês' : 'Português';
    $('tr-in').placeholder = pt ? 'Escreva aqui em português…' : 'Write here in English…';
    $('tr-in-tools').hidden = pt;                     // botões de copiar/ouvir ficam no lado que está em inglês
    $('tr-out-tools').hidden = !pt || !$('tr-out').textContent || $('tr-out').classList.contains('err');
    if (!pt) $('tr-in-tools').hidden = !$('tr-in').value.trim();
  }
  function trDo() {
    var text = $('tr-in').value.trim();
    var out = $('tr-out');
    if (!text) { out.textContent = ''; out.classList.remove('err'); trPaint(); return; }
    var from = trDir === 'pt-en' ? 'pt' : 'en';
    var to = trDir === 'pt-en' ? 'en' : 'pt';
    var my = ++trTimer;
    out.classList.remove('err');
    out.textContent = 'Traduzindo…';
    $('tr-out-tools').hidden = true;
    translateText(text, from, to).then(function (t) {
      if (my !== trTimer) return;
      out.textContent = t;
      trPaint();
    }, function () {
      if (my !== trTimer) return;
      out.classList.add('err');
      out.textContent = 'Não consegui traduzir agora. Verifique sua internet e tente de novo.';
      trPaint();
    });
  }
  var ttsVoice = null;
  function pickVoice() {
    try {
      var vs = window.speechSynthesis.getVoices();
      ttsVoice = vs.filter(function (x) { return /^en[-_]US/i.test(x.lang); })[0] || vs.filter(function (x) { return /^en/i.test(x.lang); })[0] || ttsVoice;
    } catch (e) { /* ignorar */ }
  }
  // Aquece a voz antes de precisar: carrega a lista de vozes e fala uma frase muda,
  // para o primeiro "ouvir" não demorar vários segundos.
  var ttsWarm = false;
  function warmTTS(withUtterance) {
    if (!('speechSynthesis' in window)) return;
    pickVoice();
    if (withUtterance && !ttsWarm) {
      ttsWarm = true;
      try {
        var u = new SpeechSynthesisUtterance(' ');
        u.volume = 0; u.lang = 'en-US';
        if (ttsVoice) u.voice = ttsVoice;
        window.speechSynthesis.speak(u);
      } catch (e) { /* ignorar */ }
    }
  }
  if ('speechSynthesis' in window) {
    pickVoice();
    try { window.speechSynthesis.addEventListener('voiceschanged', pickVoice); } catch (e) { /* ignorar */ }
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
      window.addEventListener(ev, function once() { window.removeEventListener(ev, once, true); warmTTS(true); }, true);
    });
    setTimeout(function () { warmTTS(true); }, 800);   // navegadores que permitem sem toque
  }
  function trSpeak(text) {
    if (!text || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 0.95;
      if (!ttsVoice) pickVoice();
      if (ttsVoice) u.voice = ttsVoice;
      window.speechSynthesis.speak(u);
    } catch (e) { /* ignorar */ }
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-say]') : null;
    if (b) trSpeak(b.getAttribute('data-say'));
  });
  $('tr-go').addEventListener('click', trDo);
  $('tr-in').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); trDo(); } });
  $('tr-in').addEventListener('input', function () { if (trDir === 'en-pt') trPaint(); });
  $('tr-swap').addEventListener('click', function () {
    var out = $('tr-out');
    var had = out.textContent && !out.classList.contains('err') && out.textContent !== 'Traduzindo…' ? out.textContent : '';
    trDir = trDir === 'pt-en' ? 'en-pt' : 'pt-en';
    $('tr-in').value = had;   // o resultado vira o novo texto de entrada
    out.textContent = '';
    out.classList.remove('err');
    trPaint();
  });
  $('pane-tr').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-tr]') : null;
    if (!b) return;
    var text = (b.getAttribute('data-box') === 'in' ? $('tr-in').value : $('tr-out').textContent).trim();
    if (!text) return;
    if (b.getAttribute('data-tr') === 'say') { trSpeak(text); return; }
    if (!session) return;
    var old = b.textContent;
    b.disabled = true;
    A.api('POST', '/api/classes/' + encodeURIComponent(classId) + '/chat', { studentId: session.studentId, text: text, speak: true }).then(function () {
      b.textContent = 'Enviado!';
      setTab('chat');
      setTimeout(function () { b.textContent = old; b.disabled = false; }, 1200);
    }, function (ex) {
      b.textContent = old; b.disabled = false;
      setWarn(ex.message, false);
      setTimeout(function () { setWarn(null); }, 3000);
    });
  });
  if (!('speechSynthesis' in window)) { document.querySelectorAll('[data-tr="say"]').forEach(function (b) { b.hidden = true; }); }
  trPaint();

  // ---------- dinâmicas da sala ----------
  var dyn = { key: null, data: null, trv: -1, trq: -1, fetched: 0, tick: 0 };
  var actSub = 'din';
  var qEl = $('q-body');
  var dynEl = $('dyn-body');
  var dynBusy = false;
  function dynSet(d) {
    var changed = !dyn.data || d.v !== dyn.data.v;
    if (changed && dyn.data && chatTab !== 'dyn') { dynSeen = false; paintChatToggle(); }
    dyn.data = d;
    dyn.recv = Date.now();
    dyn.fetched = Date.now();
    dynPaint();
  }
  function syncDyn() {
    var key = snap && snap.room ? snap.round + ':' + snap.room.id : null;
    if (key !== dyn.key) { dyn = { key: key, data: null, trv: -1, trq: -1, fetched: 0, tick: dyn.tick }; dynPaint(); }
    if (!key || !session) return;
    if (Date.now() - dyn.fetched < 15000) return;
    dyn.fetched = Date.now();
    A.api('GET', '/api/classes/' + encodeURIComponent(classId) + '/dyn?studentId=' + encodeURIComponent(session.studentId)).then(function (r) {
      if (dyn.key === key && r.data) dynSet(r.data);
    }, function () { /* ignorar */ });
  }
  function dynAct(action) {
    if (!session || dynBusy) return;
    dynBusy = true;
    A.api('POST', '/api/classes/' + encodeURIComponent(classId) + '/dyn', { studentId: session.studentId, action: action }).then(function () { dynBusy = false; }, function (ex) {
      dynBusy = false;
      setWarn(ex.message, false);
      setTimeout(function () { setWarn(null); }, 3000);
    });
  }
  function ptLine(x, show) { return show && x && x.pt ? '<p class="pt">' + A.esc(x.pt) + '</p>' : ''; }
  function qPaint() {
    var d = dyn.data;
    if (!snap || !snap.room) { qEl.innerHTML = '<p class="none">As perguntas aparecem quando você estiver em uma sala.</p>'; return; }
    if (!d || !d.pergunta) { qEl.innerHTML = '<p class="none">' + (d ? 'Nenhuma pergunta disponível.' : 'Carregando…') + '</p>'; return; }
    var show = dyn.trq === d.pn;
    qEl.innerHTML = '<div class="box"><span class="lbl">Pergunta para a sala</span><span class="big" style="font-size:26px">' + A.esc(d.pergunta.en) + '</span>' + ptLine(d.pergunta, show) + '</div>' +
      '<p class="small">Cada pessoa responde em inglês, uma de cada vez.</p>' +
      (show ? '' : '<button class="btn btn-sm" data-dyn="qtrans" type="button">Ver tradução</button>') +
      '<button class="btn btn-primary" data-dyn="qnext" type="button">Sortear outra pergunta</button>';
  }
  function subPaint() {
    document.querySelectorAll('#pane-dyn .sub').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-sub') === actSub); });
    dynEl.hidden = actSub !== 'din';
    qEl.hidden = actSub !== 'per';
  }
  document.querySelectorAll('#pane-dyn .sub').forEach(function (b) {
    b.addEventListener('click', function () { actSub = b.getAttribute('data-sub'); subPaint(); });
  });
  qEl.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-dyn]') : null;
    if (!b) return;
    if (b.getAttribute('data-dyn') === 'qtrans') { dyn.trq = dyn.data.pn; qPaint(); return; }
    dynAct('qnext');
  });
  function dynPaint() {
    qPaint();
    var d = dyn.data;
    if (!snap || !snap.room) { dynEl.innerHTML = '<p class="none">As dinâmicas aparecem quando você estiver em uma sala.</p>'; return; }
    if (!d || d.empty) { dynEl.innerHTML = '<p class="none">' + (d ? 'Nenhuma dinâmica disponível.' : 'Carregando…') + '</p>'; return; }
    var show = dyn.trv === d.v;
    var h = '<h3>' + A.esc(d.nome) + '</h3>';
    var hasEn = false;
    if (!d.started) {
      h += '<p class="expl">' + A.esc(d.explicacao) + '</p><div class="btnrow">' +
        (d.outras ? '<button class="btn" data-dyn="next" type="button">Sortear outra</button>' : '<span></span>') +
        '<button class="btn btn-primary" data-dyn="start" type="button">Iniciar</button></div>';
      dynEl.innerHTML = h;
      return;
    }
    if (d.tipo === 'impostor') {
      hasEn = !d.impostor;
      h += '<p class="small">Categoria: <b>' + A.esc(d.categoria.pt) + '</b> (' + A.esc(d.categoria.en) + ')</p>';
      if (d.impostor && !d.revelado) h += '<div class="box imp"><span class="lbl">Só você vê isto</span><span class="big">Você é o IMPOSTOR</span><span>Fale uma frase sem deixar claro que você não sabe a palavra.</span></div>';
      else h += '<div class="box"><span class="lbl">A palavra é</span><span class="big">' + A.esc(d.palavra.en) + '</span>' + ptLine(d.palavra, show) + '</div>';
      if (d.revelado) h += '<div class="box imp"><span class="lbl">O impostor era</span><span class="big">' + A.esc(d.nomeImpostor) + '</span></div>';
      else h += '<button class="btn" data-dyn="reveal" type="button">Revelar o impostor</button>';
      if (!d.impostor && !d.revelado) h += '<p class="small">Cada um fala uma frase em inglês que ajude a entender a palavra, sem dizê-la.</p>';
    } else if (d.tipo === 'mimica') {
      hasEn = true;
      h += '<div class="box"><span class="lbl">Sua palavra (só você vê)</span><span class="big">' + A.esc(d.palavra.en) + '</span>' + ptLine(d.palavra, show) + '</div>';
      h += '<div class="dtimer" id="dyn-timer" role="timer"></div><button class="btn btn-primary" id="dyn-mim" data-dyn="mimica" type="button">Começar ' + d.segundos + ' segundos</button>';
    } else if (d.tipo === 'quemsou') {
      hasEn = true;
      h += '<p class="small">Você vê quem os outros são. Descubra quem é você com perguntas de sim ou não.</p><div class="who-list">' +
        d.outros.map(function (o) { return '<div class="box"><span class="lbl">' + A.esc(o.nome) + ' é</span><b>' + A.esc(o.id.en) + '</b>' + ptLine(o.id, show) + '</div>'; }).join('') + '</div>';
      if (!d.outros.length) h += '<p class="none">Ainda não há outros jogadores na sala.</p>';
    } else {
      hasEn = true;
      h += '<div class="box"><span class="lbl">' + (d.tipo === 'leilao' ? 'Objeto à venda' : 'Início da história') + '</span><span class="big" style="font-size:' + (d.tipo === 'leilao' ? 28 : 22) + 'px">' + A.esc(d.item.en) + '</span>' + ptLine(d.item, show) + '</div>';
      h += '<p class="small">' + (d.tipo === 'leilao' ? 'Escolham quem vai vender. Ele(a) convence os outros a comprar.' : 'Continuem a história, um de cada vez, em inglês.') + '</p>';
    }
    if (hasEn && !show) h += '<button class="btn btn-sm" data-dyn="trans" type="button">Ver tradução</button>';
    h += '<div class="btnrow"><button class="btn" data-dyn="again" type="button">Brincar novamente</button>' +
      (d.outras ? '<button class="btn" data-dyn="next" type="button">Sortear outra</button>' : '<span></span>') + '</div>';
    dynEl.innerHTML = h;
    dynTimerPaint();
  }
  function dynTimerPaint() {
    var d = dyn.data, t = $('dyn-timer'), b = $('dyn-mim');
    if (!t || !d) return;
    var left = d.endsAt ? Math.ceil((d.endsAt - (Date.now() + (d.now - dyn.recv))) / 1000) : null;
    if (left == null || left <= -3) { t.textContent = d.segundos + 's'; t.classList.remove('low'); if (b) b.disabled = false; return; }
    if (left <= 0) { t.textContent = 'Acabou o tempo!'; t.classList.add('low'); if (b) b.disabled = false; return; }
    t.textContent = A.mmss(left);
    t.classList.toggle('low', left <= 5);
    if (b) b.disabled = true;
  }
  dynEl.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-dyn]') : null;
    if (!b) return;
    var a = b.getAttribute('data-dyn');
    if (a === 'trans') { dyn.trv = dyn.data.v; dynPaint(); return; }
    dynAct(a);
  });
  setInterval(function () { if (dyn.data && dyn.data.tipo === 'mimica' && chatTab === 'dyn') dynTimerPaint(); }, 250);

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
