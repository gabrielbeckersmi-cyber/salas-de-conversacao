/* Painel do professor: criar aula, montar salas arrastando alunos, ver todas as salas, ouvir e falar com uma sala por vez. */
(function () {
  'use strict';
  var A = App;
  var LK = window.LivekitClient;
  var esc = A.esc;
  var $ = function (id) { return document.getElementById(id); };
  var app = $('app');
  var audioBox = $('audio');
  var TOKEN_KEY = 'salas:professor';
  var token = '';
  try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { token = ''; }
  var parts = location.pathname.split('/').filter(Boolean);
  var classId = parts[1] || null;

  var S = null;            // última foto da aula enviada pelo servidor
  var offset = 0;          // diferença entre o relógio do servidor e o deste computador
  var ws = null;
  var views = new Map();   // roomId -> RoomView (uma conexão LiveKit por sala)
  var ui = { n: null, confirm: null, warn: '', net: false, watch: new Set() };

  function T(method, url, body) {
    return A.api(method, url, body, token).catch(function (e) {
      if (e.status === 401) logout('Sessão expirada. Entre de novo.');
      throw e;
    });
  }

  function logout(msg) {
    token = '';
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignorar */ }
    destroyViews();
    if (ws) { ws.close(); ws = null; }
    S = null;
    viewLogin(msg);
  }

  // ======================================================== login
  function viewLogin(msg) {
    app.innerHTML = '<form class="card narrow" id="login" novalidate>' +
      '<h1>Painel do professor</h1><p>Digite a senha para continuar.</p>' +
      (msg ? '<div class="msg info">' + esc(msg) + '</div>' : '') +
      '<div class="field"><label class="lbl" for="pw">Senha</label><input class="input" id="pw" type="password" autocomplete="current-password" required></div>' +
      '<div class="msg err" id="lerr" role="alert" hidden></div>' +
      '<button class="btn btn-primary" type="submit">Entrar</button></form>';
    $('login').addEventListener('submit', function (e) {
      e.preventDefault();
      $('lerr').hidden = true;
      A.api('POST', '/api/professor/login', { password: $('pw').value }).then(function (r) {
        token = r.token;
        try { localStorage.setItem(TOKEN_KEY, token); } catch (e2) { /* ignorar */ }
        boot();
      }, function (ex) { $('lerr').textContent = ex.message; $('lerr').hidden = false; });
    });
    setTimeout(function () { var p = $('pw'); if (p) p.focus(); }, 50);
  }

  // ======================================================== lista de aulas
  var PHASE_TEXT = { lobby: 'Aberta para entrada', r1: 'Rodada 1 ao vivo', between: 'Intervalo', r2: 'Rodada 2 ao vivo', done: 'Encerrada' };

  function viewList() {
    app.innerHTML = '<p class="small">Carregando…</p>';
    T('GET', '/api/professor/classes').then(function (r) {
      var d = new Date();
      var def = 'Aula de conversação · ' + String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
      app.innerHTML = '<div class="topbar"><div><h1>Salas de Conversação</h1><p class="sub">Painel do professor</p></div><button class="btn btn-sm" data-act="logout" type="button">Sair</button></div>' +
        (r.livekit ? '' : '<div class="msg err">O servidor ainda não tem o LiveKit configurado (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET). Sem isso a aula não consegue começar.</div>') +
        '<form class="card" id="new-class" novalidate><h2>Nova aula</h2>' +
        '<p class="small">Cada aula tem um link só dela. Poste o link da aula de quinta para os alunos de quinta, o da sexta para os de sexta.</p>' +
        '<div class="form-row"><div class="field"><label class="lbl" for="c-title">Nome da aula</label><input class="input" id="c-title" maxlength="60" value="' + esc(def) + '"></div>' +
        '<div class="field"><label class="lbl" for="c-min">Min. por rodada</label><input class="input" id="c-min" type="number" min="1" max="30" value="15"></div></div>' +
        '<div class="msg err" id="c-err" role="alert" hidden></div>' +
        '<div><button class="btn btn-primary" type="submit">Criar aula e gerar link</button></div></form>' +
        '<div class="classes">' + (r.classes.length ? r.classes.map(classRow).join('') : '<p class="empty">Nenhuma aula criada ainda.</p>') + '</div>';
      $('new-class').addEventListener('submit', function (e) {
        e.preventDefault();
        T('POST', '/api/professor/classes', { title: $('c-title').value, roundMinutes: Number($('c-min').value) || 15 })
          .then(function (c) { location.href = '/professor/' + c.id; })
          .catch(function (ex) { $('c-err').textContent = ex.message; $('c-err').hidden = false; });
      });
    }, function (e) { app.innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; });
  }

  function classRow(c) {
    var url = location.origin + '/aula/' + c.id;
    var cls = c.phase === 'done' ? 'pill' : (c.phase === 'lobby' ? 'pill ok' : 'pill live');
    return '<div class="crow"><div class="crow-top"><div><h3>' + esc(c.title) + '</h3>' +
      '<p class="small">' + c.students + ' aluno' + (c.students === 1 ? '' : 's') + ' · criada em ' + new Date(c.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + '</p></div>' +
      '<span class="' + cls + '">' + PHASE_TEXT[c.phase] + '</span></div>' +
      '<div class="linkrow"><input class="input" readonly value="' + esc(url) + '" aria-label="Link da aula para os alunos">' +
      '<button class="btn btn-sm" data-act="copy-row" data-url="' + esc(url) + '" type="button">' + A.ICON.link + 'Copiar link</button>' +
      '<a class="btn btn-primary btn-sm" href="/professor/' + c.id + '">Abrir painel</a></div></div>';
  }

  // ======================================================== painel da aula
  var netTimer = null;
  function viewPanel() {
    app.innerHTML = '<p class="small">Conectando à aula…</p>';
    ws = A.connectWS('/ws?role=teacher&class=' + encodeURIComponent(classId) + '&token=' + encodeURIComponent(token), {
      onOpen: function () { clearTimeout(netTimer); if (ui.net) { ui.net = false; render(); } },
      onMessage: function (m) {
        if (m.type === 'state') { S = m.data; offset = S.now - Date.now(); onState(); }
      },
      onClose: function (e) {
        if (e.code === 4001) logout('Sessão expirada. Entre de novo.');
        else if (e.code === 4004) app.innerHTML = '<div class="card narrow"><h1>Aula não encontrada</h1><p>O servidor não conhece esta aula. Se ele foi reiniciado sem disco persistente, as aulas se perdem.</p><a class="btn btn-primary" href="/professor">Voltar às aulas</a></div>';
        else if (S) { clearTimeout(netTimer); netTimer = setTimeout(function () { ui.net = true; render(); }, 3000); }
      }
    });
  }

  function onState() {
    syncViews();
    applyHear();
    render();
  }

  // ---------- conexões LiveKit (uma por sala; o professor só publica áudio na sala escolhida) ----------
  function mountVideo(view, pid) {
    var v = view.videos.get(pid);
    if (!v) return;
    var slot = document.querySelector('.slot[data-room="' + view.id + '"][data-pid="' + pid + '"]');
    if (slot && v.parentNode !== slot) {
      slot.appendChild(v);
      var p = v.play();
      if (p && p.catch) p.catch(function () { /* ignorar */ });
    }
  }
  function paintTile(view, pid) {
    var t = document.querySelector('.tile[data-room="' + view.id + '"][data-pid="' + pid + '"]');
    if (!t) return;
    t.classList.toggle('has-video', view.videoOn.has(pid));
    t.classList.toggle('video-off', view.videoOff.has(pid));
    t.classList.toggle('mic-off', view.micOff.has(pid));
    t.classList.toggle('speaking', view.speaking.has(pid));
  }
  function paintAll(view) {
    document.querySelectorAll('.tile[data-room="' + view.id + '"]').forEach(function (t) { paintTile(view, t.getAttribute('data-pid')); });
  }

  class RoomView {
    constructor(r) {
      this.id = r.id;
      this.name = r.lk.room;
      this.token = r.lk.token;
      this.room = null;
      this.connected = false;
      this.dead = false;
      this.listening = false;
      this.talking = false;
      this.watching = false;
      this.videos = new Map();
      this.videoOn = new Set();
      this.videoOff = new Set();
      this.micOff = new Set();
      this.speaking = new Set();
      this.audioEls = new Map();
      this.chain = Promise.resolve();
      this.rt = null;
      this.connect();
    }
    connect() {
      if (this.dead) return;
      var self = this;
      var room = new LK.Room({ adaptiveStream: true, dynacast: false });
      this.room = room;
      var E = LK.RoomEvent;
      room.on(E.TrackPublished, function (pub, p) { self.onPub(pub, p); });
      room.on(E.TrackSubscribed, function (track, pub, p) { self.onSub(track, pub, p); });
      room.on(E.TrackUnsubscribed, function (track, pub, p) { self.onUnsub(track, pub, p); });
      room.on(E.TrackMuted, function (pub, p) { self.onMute(pub, p, true); });
      room.on(E.TrackUnmuted, function (pub, p) { self.onMute(pub, p, false); });
      room.on(E.ParticipantDisconnected, function (p) { self.drop(p.identity); });
      room.on(E.ActiveSpeakersChanged, function (sp) {
        self.speaking = new Set(sp.map(function (s) { return s.identity; }));
        paintAll(self);
      });
      room.on(E.Disconnected, function () {
        if (self.dead || self.room !== room) return;
        self.connected = false;
        clearTimeout(self.rt);
        self.rt = setTimeout(function () { self.connect(); }, 3000);
      });
      room.connect(S.lk.url, this.token, { autoSubscribe: false }).then(function () {
        if (self.dead) { room.disconnect(); return; }
        self.connected = true;
        room.remoteParticipants.forEach(function (p) {
          p.trackPublications.forEach(function (pub) { self.onPub(pub, p); });
        });
        if (self.talking) self.setTalking(true);
      }, function () {
        if (self.dead) return;
        clearTimeout(self.rt);
        self.rt = setTimeout(function () { self.connect(); }, 3000);
      });
    }
    onPub(pub, p) {
      if (p.identity === 'professor') return;
      if (pub.kind === 'video') pub.setSubscribed(this.watching);
      else if (pub.kind === 'audio') pub.setSubscribed(this.listening);
    }
    onSub(track, pub, p) {
      var pid = p.identity;
      if (track.kind === 'video') {
        var v = this.videos.get(pid);
        if (!v) {
          v = document.createElement('video');
          v.autoplay = true; v.muted = true; v.playsInline = true;
          this.videos.set(pid, v);
        }
        track.attach(v);
        this.videoOn.add(pid);
        if (pub.isMuted) this.videoOff.add(pid); else this.videoOff.delete(pid);
        mountVideo(this, pid);
        paintTile(this, pid);
      } else if (track.kind === 'audio') {
        var el = track.attach();
        audioBox.appendChild(el);
        this.audioEls.set(pub.trackSid, el);
        if (pub.isMuted) this.micOff.add(pid); else this.micOff.delete(pid);
        paintTile(this, pid);
      }
    }
    onUnsub(track, pub, p) {
      var pid = p.identity;
      var els = track.detach();
      if (track.kind === 'audio') {
        els.forEach(function (el) { el.remove(); });
        this.audioEls.delete(pub.trackSid);
      } else {
        this.videoOn.delete(pid);
        paintTile(this, pid);
      }
    }
    onMute(pub, p, muted) {
      var set = pub.kind === 'video' ? this.videoOff : (pub.kind === 'audio' ? this.micOff : null);
      if (!set) return;
      if (muted) set.add(p.identity); else set.delete(p.identity);
      paintTile(this, p.identity);
    }
    drop(pid) {
      var v = this.videos.get(pid);
      if (v) { v.srcObject = null; v.remove(); this.videos.delete(pid); }
      this.videoOn.delete(pid); this.videoOff.delete(pid); this.micOff.delete(pid); this.speaking.delete(pid);
      paintTile(this, pid);
    }
    setWatching(on) {
      this.watching = on;
      if (!this.connected) return;
      this.room.remoteParticipants.forEach(function (p) {
        p.trackPublications.forEach(function (pub) { if (pub.kind === 'video') pub.setSubscribed(on); });
      });
    }
    setListening(on) {
      this.listening = on;
      if (!this.connected) return;
      this.room.remoteParticipants.forEach(function (p) {
        p.trackPublications.forEach(function (pub) { if (pub.kind === 'audio') pub.setSubscribed(on); });
      });
    }
    setTalking(on) {
      var self = this;
      this.talking = on;
      this.chain = this.chain.then(function () {
        if (!self.connected) return null;
        var lp = self.room.localParticipant;
        if (on) return lp.setMicrophoneEnabled(true);
        var pub = lp.getTrackPublication(LK.Track.Source.Microphone);
        return pub && pub.track ? lp.unpublishTrack(pub.track, true) : null;
      }).catch(function () {
        if (on) { ui.warn = 'Não consegui usar o microfone. Libere a permissão do navegador (cadeado ao lado do endereço) e tente de novo.'; render(); }
      });
    }
    destroy() {
      this.dead = true;
      clearTimeout(this.rt);
      try { if (this.room) this.room.disconnect(); } catch (e) { /* ignorar */ }
      this.audioEls.forEach(function (el) { el.remove(); });
      this.videos.forEach(function (v) { v.srcObject = null; v.remove(); });
    }
  }

  function destroyViews() {
    views.forEach(function (v) { v.destroy(); });
    views.clear();
  }
  function syncViews() {
    var live = S.phase === 'r1' || S.phase === 'r2';
    var want = new Map();
    if (!live) ui.watch.clear();
    // Só conecta nas salas que você está vendo ou ouvindo: sem conexão, sem consumo de minutos.
    if (live) S.rooms.forEach(function (r) {
      if (r.lk && (ui.watch.has(r.id) || (S.hear && S.hear.roomId === r.id))) want.set(r.id, r);
    });
    views.forEach(function (v, id) {
      var r = want.get(id);
      if (!r || r.lk.room !== v.name) { v.destroy(); views.delete(id); }
    });
    want.forEach(function (r, id) { if (!views.has(id)) views.set(id, new RoomView(r)); });
  }
  function applyHear() {
    var h = S && S.hear;
    views.forEach(function (v, id) {
      var w = ui.watch.has(id);
      if (v.watching !== w) v.setWatching(w);
      var l = !!h && h.roomId === id;
      if (v.listening !== l) v.setListening(l);
      var t = l && h.mode === 'talk';
      if (v.talking !== t) v.setTalking(t);
    });
  }
  function startAudioAll() {
    views.forEach(function (v) { try { if (v.room) v.room.startAudio(); } catch (e) { /* ignorar */ } });
  }

  // ---------- ações ----------
  function act(body) {
    ui.warn = '';
    return T('POST', '/api/professor/classes/' + classId + '/act', body).catch(function (e) {
      ui.warn = e.message;
      return T('GET', '/api/professor/classes/' + classId).then(function (d) { S = d; offset = S.now - Date.now(); onState(); }, function () { render(); });
    });
  }
  function moveLocal(pid, roomId) {
    S.rooms.forEach(function (r) { r.members = r.members.filter(function (m) { return m !== pid; }); });
    if (roomId) {
      var t = S.rooms.find(function (r) { return r.id === roomId; });
      if (t) t.members.push(pid);
    }
    var st = S.students.find(function (s) { return s.pid === pid; });
    if (st) st.callAt = null;
  }
  function doMove(pid, roomId) {
    moveLocal(pid, roomId);
    render();
    act({ action: 'move', pid: pid, roomId: roomId });
  }
  function setHear(next) {
    S.hear = next;
    syncViews();
    applyHear();
    render();
    act({ action: 'hear', roomId: next ? next.roomId : null, mode: next ? next.mode : null });
  }

  // ---------- desenho ----------
  var PHASE_LABEL = { lobby: 'Sala de espera', r1: 'Rodada 1 de 2', between: 'Intervalo', r2: 'Rodada 2 de 2', done: 'Aula encerrada' };
  function isLive() { return S.phase === 'r1' || S.phase === 'r2'; }
  function isPlanning() { return S.phase === 'lobby' || S.phase === 'between'; }

  function levelOf(r, by) {
    var set = new Set();
    r.members.forEach(function (p) { if (by[p]) set.add(by[p].level); });
    if (!set.size) return null;
    return set.size > 1 ? 'misto' : Array.from(set)[0];
  }

  function mvSelect(s, roomId) {
    var opts = '<option value=""' + (roomId ? '' : ' selected') + '>Sem sala</option>' + S.rooms.map(function (r) {
      return '<option value="' + r.id + '"' + (r.id === roomId ? ' selected' : '') + '>Sala ' + r.no + '</option>';
    }).join('');
    return '<label class="mvw" title="Mover para outra sala">&#8644;<select class="mv" data-pid="' + s.pid + '" aria-label="Mover ' + esc(s.name) + ' para outra sala">' + opts + '</select></label>';
  }
  function chipHTML(s, roomId) {
    return '<div class="pchip ' + A.LEVEL_CLS[s.level] + '" draggable="true" data-pid="' + s.pid + '">' +
      '<span class="avatar">' + esc(A.initials(s.name)) + '</span>' +
      '<span class="pn" title="' + esc(s.name) + ' (' + A.LEVEL_NAME[s.level] + ')">' + esc(s.name) + '</span>' +
      '<span class="st ' + (s.online ? 'on' : 'off') + '" title="' + (s.online ? 'online' : 'offline') + '"></span>' +
      mvSelect(s, roomId) +
      (s.online ? '' : '<button class="kick" data-act="kick" data-pid="' + s.pid + '" title="Remover aluno" aria-label="Remover ' + esc(s.name) + '" type="button">&times;</button>') +
      '</div>';
  }
  function tileHTML(r, s) {
    return '<div class="tile ' + A.LEVEL_CLS[s.level] + '" draggable="true" data-pid="' + s.pid + '" data-room="' + r.id + '">' +
      '<span class="avatar">' + esc(A.initials(s.name)) + '</span>' +
      '<span class="slot" data-room="' + r.id + '" data-pid="' + s.pid + '"></span>' +
      '<span class="nm" title="' + esc(s.name) + '">' + esc(s.name) + (s.online ? '' : ' (offline)') + '</span>' +
      '<span class="micoff">' + A.ICON.micoff + '</span>' +
      mvSelect(s, r.id) + '</div>';
  }

  function roomHTML(r, by) {
    var live = isLive();
    var lvl = levelOf(r, by);
    var members = r.members.map(function (p) { return by[p]; }).filter(Boolean);
    var calling = members.some(function (s) { return s.callAt; });
    var listening = !!S.hear && S.hear.roomId === r.id;
    var talking = listening && S.hear.mode === 'talk';
    var body;
    if (live) body = members.length ? '<div class="tiles">' + members.map(function (s) { return tileHTML(r, s); }).join('') + '</div>' : '<p class="empty">Sala vazia. Arraste alguém para cá.</p>';
    else body = '<div class="plist">' + (members.length ? members.map(function (s) { return chipHTML(s, r.id); }).join('') : '<span class="empty">Sala vazia. Arraste alguém para cá.</span>') + '</div>';
    var status = '';
    var actions = '';
    if (live) {
      if (talking) status = '<span class="tag live"><i class="pulse"></i>Seu microfone está aberto</span>';
      else if (calling) status = '<span class="tag call"><i class="pulse"></i>Chamando professor</span>';
      else if (listening) status = '<span class="tag hear"><span class="eq"><i></i><i></i><i></i></span>Ouvindo a sala</span>';
      else status = '<span>Sem áudio</span>';
      actions = '<div class="room-actions">' +
        '<button class="btn wide" data-act="watch" data-room="' + r.id + '" aria-pressed="' + ui.watch.has(r.id) + '" type="button">' + A.ICON.cam + (ui.watch.has(r.id) ? 'Parar de ver vídeo' : 'Ver vídeo') + '</button>' +
        '<button class="btn" data-act="listen" data-room="' + r.id + '" aria-pressed="' + listening + '" type="button">' + A.ICON.head + 'Ouvir</button>' +
        '<button class="btn btn-live" data-act="talk" data-room="' + r.id + '" aria-pressed="' + talking + '" type="button">' + A.ICON.mic + (talking ? 'Falando' : 'Falar') + '</button></div>';
    } else if (!members.length) {
      actions = '<div class="room-actions"><button class="btn btn-sm wide" data-act="remove-room" data-room="' + r.id + '" type="button">Remover sala vazia</button></div>';
    }
    return '<article class="room ' + (lvl ? A.LEVEL_CLS[lvl] : '') + (calling ? ' calling' : '') + (listening ? ' hearing' : '') + '" data-drop="' + r.id + '">' +
      '<div class="room-head"><h3>Sala ' + r.no + '</h3><span class="badge">' + (lvl ? A.LEVEL_NAME[lvl] : 'Vazia') + ' · ' + members.length + '</span></div>' +
      body + (status ? '<div class="room-status">' + status + '</div>' : '') + actions + '</article>';
  }

  function confirmText() {
    if (ui.confirm === 'start') {
      var n = S.students.length;
      if (S.phase === 'between') return 'Iniciar a rodada 2 com as salas abaixo? Cada aluno será levado para a nova sala.';
      return 'Ao iniciar, a aula é trancada e nenhum aluno novo poderá entrar. Iniciar agora com ' + n + ' aluno' + (n === 1 ? '' : 's') + '?';
    }
    if (ui.confirm === 'end-round') return S.phase === 'r2' ? 'Encerrar a rodada 2 e terminar a aula?' : 'Encerrar a rodada 1 agora? Todos voltam para a sala de espera.';
    if (ui.confirm === 'end-class') return 'Encerrar a aula agora? Todos os alunos serão desconectados.';
    return '';
  }

  function render() {
    if (!S) return;
    var by = {};
    S.students.forEach(function (s) { by[s.pid] = s; });
    var assigned = new Set();
    S.rooms.forEach(function (r) { r.members.forEach(function (p) { assigned.add(p); }); });
    var unassigned = S.students.filter(function (s) { return !assigned.has(s.pid); });
    var live = isLive();
    var planning = isPlanning();
    var url = location.origin + '/aula/' + S.id;
    var online = S.students.filter(function (s) { return s.online; }).length;
    var counts = { basico: 0, intermediario: 0 };
    S.students.forEach(function (s) { counts[s.level]++; });

    var main = { lobby: ['Iniciar aula', 'start'], between: ['Iniciar rodada 2', 'start'], r1: ['Encerrar rodada 1', 'end-round'], r2: ['Encerrar rodada 2', 'end-round'] }[S.phase];
    var h = '<header class="topbar"><div><p class="small"><a href="/professor">&larr; Aulas</a></p><h1>' + esc(S.title) + '</h1>' +
      '<div class="linkrow" style="margin-top:8px"><input class="input" readonly value="' + esc(url) + '" aria-label="Link da aula para os alunos"><button class="btn btn-sm" data-act="copy-link" data-url="' + esc(url) + '" type="button">' + A.ICON.link + 'Copiar link</button></div></div>' +
      '<div class="clock"><div><div class="phase">' + PHASE_LABEL[S.phase] + '</div><div class="timer idle" id="p-timer">' + A.mmss(S.roundMinutes * 60) + '</div><div class="bar" aria-hidden="true"><i id="p-bar"></i></div></div>' +
      (main ? '<button class="btn btn-primary" data-act="main" type="button">' + main[0] + '</button>' : '') + '</div></header>';

    h += '<div class="statsrow"><div class="stats"><span><b>' + S.students.length + '</b> alunos (' + online + ' online)</span>' +
      '<span class="lv-basico"><i class="dot"></i><b>' + counts.basico + '</b> Básico</span>' +
      '<span class="lv-inter"><i class="dot"></i><b>' + counts.intermediario + '</b> Intermediário</span>' +
      (S.rooms.length ? '<span><b>' + S.rooms.length + '</b> salas</span>' : '') +
      (unassigned.length ? '<span><b>' + unassigned.length + '</b> sem sala</span>' : '') + '</div>' +
      (planning || live ? '<button class="btn btn-sm" data-act="ask-end-class" type="button">Encerrar aula</button>' : '') + '</div>';

    if (ui.net) h += '<div class="msg info" role="status">Conexão instável. Reconectando…</div>';
    if (ui.warn) h += '<div class="msg err" role="alert">' + esc(ui.warn) + '</div>';
    if (ui.confirm) h += '<div class="confirm" role="alert"><p>' + esc(confirmText()) + '</p><button class="btn btn-primary" data-act="confirm-yes" type="button">Confirmar</button><button class="btn" data-act="confirm-no" type="button">Cancelar</button></div>';

    if (S.phase === 'done') {
      h += '<div class="card"><h2>Aula encerrada</h2><p>' + S.students.length + ' aluno' + (S.students.length === 1 ? '' : 's') + ' participaram. Você pode criar uma nova aula na lista.</p><div><a class="btn btn-primary" href="/professor">Voltar às aulas</a></div></div>';
      app.innerHTML = h;
      postRender();
      return;
    }

    if (live) {
      var calls = S.rooms.map(function (r) {
        var at = 0;
        r.members.forEach(function (p) { if (by[p] && by[p].callAt && (!at || by[p].callAt < at)) at = by[p].callAt; });
        return { r: r, at: at };
      }).filter(function (x) { return x.at; }).sort(function (a, b) { return a.at - b.at; });
      if (calls.length) {
        h += '<div class="calls"><span class="lbl">' + A.ICON.bell + 'Chamando o professor</span>' + calls.map(function (c) {
          return '<div class="call-item"><span>Sala ' + c.r.no + ' <span class="age" data-since="' + c.at + '"></span></span><button class="btn btn-sm btn-call" data-act="answer" data-room="' + c.r.id + '" type="button">Atender</button></div>';
        }).join('') + '</div>';
      }
    }

    h += '<div class="toolbar">';
    if (planning) {
      h += '<span class="lbl-t" style="margin:0">Salas</span><span class="stepper"><button class="btn btn-sm" data-act="n-minus" type="button" aria-label="Menos salas">&minus;</button><output>' + (ui.n || 'auto') + '</output><button class="btn btn-sm" data-act="n-plus" type="button" aria-label="Mais salas">+</button></span>' +
        '<button class="btn" data-act="plan" type="button">Distribuir automaticamente</button>';
    }
    h += '<button class="btn" data-act="add-room" type="button">+ Sala vazia</button></div>';
    if (planning) {
      h += '<p class="hint">' + (S.phase === 'between'
        ? (S.repeats ? S.repeats + ' par' + (S.repeats > 1 ? 'es' : '') + ' repetido' + (S.repeats > 1 ? 's' : '') + ' da rodada 1 (há poucos alunos em um dos níveis). ' : 'Sugestão da rodada 2 pronta, sem repetir parceiros da rodada 1. ')
        : 'Os alunos esperam enquanto você monta as salas. ') +
        'Arraste um aluno para outra sala, ou use o botão &#8644; ao lado do nome. Distribuir de novo refaz todos os grupos.</p>';
    } else {
      h += '<p class="hint">As salas começam só com as iniciais. “Ver vídeo” mostra o vídeo da sala escolhida (e passa a consumir dados do LiveKit só dela). “Ouvir” liga o áudio só da sala escolhida. “Falar” abre o seu microfone só para ela. Use fones de ouvido para evitar eco.</p>';
    }

    h += '<div class="board">';
    if (planning || unassigned.length) {
      h += '<section class="zone bucket" data-drop="none"><h3>Sem sala <span class="badge lv-misto">' + unassigned.length + '</span></h3><div class="plist">' +
        (unassigned.length ? unassigned.map(function (s) { return chipHTML(s, null); }).join('') : '<span class="empty">Todos os alunos estão em salas. Arraste um aluno para cá para tirá-lo de uma sala.</span>') + '</div></section>';
    }
    h += S.rooms.map(function (r) { return roomHTML(r, by); }).join('') + '</div>';

    app.innerHTML = h;
    postRender();
  }

  function postRender() {
    views.forEach(function (v) {
      v.videos.forEach(function (_el, pid) { mountVideo(v, pid); });
      paintAll(v);
    });
    tick();
  }

  function tick() {
    if (!S) return;
    var t = $('p-timer');
    var bar = $('p-bar');
    if (t && S.endsAt && isLive()) {
      var left = (S.endsAt - (Date.now() + offset)) / 1000;
      t.textContent = A.mmss(left);
      t.className = 'timer' + (left <= 60 ? ' warn' : '');
      if (bar) bar.style.width = Math.min(100, Math.max(0, 100 * (1 - left / (S.roundMinutes * 60)))) + '%';
    } else if (t) {
      t.className = 'timer idle';
      if (bar) bar.style.width = S.phase === 'done' ? '100%' : '0';
    }
    document.querySelectorAll('[data-since]').forEach(function (el) {
      var s = Math.max(0, Math.floor((Date.now() + offset - Number(el.getAttribute('data-since'))) / 1000));
      el.textContent = 'há ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    });
  }
  setInterval(tick, 500);

  // ---------- eventos ----------
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el || el.disabled) return;
    var a = el.getAttribute('data-act');
    var room = el.getAttribute('data-room');
    if (a === 'logout') { logout(); return; }
    if (a === 'copy-row' || a === 'copy-link') {
      A.copyText(el.getAttribute('data-url')).then(function (ok) {
        var old = el.innerHTML;
        el.textContent = ok ? 'Link copiado' : 'Copie manualmente';
        setTimeout(function () { el.innerHTML = old; }, 1800);
      });
      return;
    }
    if (!S) return;
    if (a === 'main') { ui.confirm = isPlanning() ? 'start' : 'end-round'; render(); return; }
    if (a === 'ask-end-class') { ui.confirm = 'end-class'; render(); return; }
    if (a === 'confirm-no') { ui.confirm = null; render(); return; }
    if (a === 'confirm-yes') {
      var what = ui.confirm;
      ui.confirm = null;
      render();
      act({ action: what });
      return;
    }
    if (a === 'plan') { act({ action: 'plan', n: ui.n || undefined }); return; }
    if (a === 'n-minus' || a === 'n-plus') {
      var cur = ui.n || S.rooms.length || 2;
      ui.n = Math.min(30, Math.max(1, cur + (a === 'n-plus' ? 1 : -1)));
      render();
      return;
    }
    if (a === 'add-room') { act({ action: 'add-room' }); return; }
    if (a === 'remove-room') { act({ action: 'remove-room', roomId: room }); return; }
    if (a === 'kick') { act({ action: 'kick', pid: el.getAttribute('data-pid') }); return; }
    if (a === 'watch') {
      if (ui.watch.has(room)) ui.watch.delete(room); else ui.watch.add(room);
      syncViews(); applyHear(); render();
      return;
    }
    if (a === 'listen') {
      startAudioAll();
      setHear(S.hear && S.hear.roomId === room ? null : { roomId: room, mode: 'listen' });
      return;
    }
    if (a === 'talk') {
      startAudioAll();
      setHear(S.hear && S.hear.roomId === room && S.hear.mode === 'talk' ? { roomId: room, mode: 'listen' } : { roomId: room, mode: 'talk' });
      return;
    }
    if (a === 'answer') {
      startAudioAll();
      S.students.forEach(function (s) { var r = S.rooms.find(function (x) { return x.id === room; }); if (r && r.members.indexOf(s.pid) !== -1) s.callAt = null; });
      setHear({ roomId: room, mode: 'talk' });
      act({ action: 'answer', roomId: room });
    }
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el && el.matches && el.matches('select.mv')) doMove(el.getAttribute('data-pid'), el.value || null);
  });

  // arrastar e soltar (aluno -> sala ou "sem sala")
  var dragPid = null;
  document.addEventListener('dragstart', function (e) {
    var el = e.target.closest ? e.target.closest('[data-pid][draggable="true"]') : null;
    if (!el) return;
    dragPid = el.getAttribute('data-pid');
    try { e.dataTransfer.setData('text/plain', dragPid); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* ignorar */ }
    el.classList.add('dragging');
  });
  document.addEventListener('dragend', function (e) {
    if (e.target && e.target.classList) e.target.classList.remove('dragging');
    dragPid = null;
    document.querySelectorAll('.over').forEach(function (z) { z.classList.remove('over'); });
  });
  document.addEventListener('dragover', function (e) {
    var z = e.target.closest ? e.target.closest('[data-drop]') : null;
    if (!z || !dragPid) return;
    e.preventDefault();
    document.querySelectorAll('.over').forEach(function (o) { if (o !== z) o.classList.remove('over'); });
    z.classList.add('over');
  });
  document.addEventListener('drop', function (e) {
    var z = e.target.closest ? e.target.closest('[data-drop]') : null;
    if (!z || !dragPid || !S) return;
    e.preventDefault();
    var pid = dragPid;
    var to = z.getAttribute('data-drop');
    dragPid = null;
    document.querySelectorAll('.over').forEach(function (o) { o.classList.remove('over'); });
    var from = S.rooms.find(function (r) { return r.members.indexOf(pid) !== -1; });
    var target = to === 'none' ? null : to;
    if ((from ? from.id : null) === target) return;
    doMove(pid, target);
  });

  // ---------- início ----------
  function boot() {
    if (!token) { viewLogin(); return; }
    if (classId) viewPanel(); else viewList();
  }
  boot();
})();
