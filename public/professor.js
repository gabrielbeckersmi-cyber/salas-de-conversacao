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
  // identidade única deste professor no LiveKit (dois professores na mesma sala não podem repetir a identidade)
  var tid = Math.random().toString(36).slice(2, 10) || 'abcdef';
  function isProf(id) { return /^prof-/.test(String(id)); }

  var NAME_KEY = 'salas:profname';
  var DEV_KEY = 'salas:profdev';
  var profName = '';
  try { profName = localStorage.getItem(NAME_KEY) || ''; } catch (e) { profName = ''; }
  function saveName(n) {
    profName = String(n || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    try { localStorage.setItem(NAME_KEY, profName); } catch (e) { /* ignorar */ }
  }

  // ---------- escolha de câmera e microfone (a escolha fica salva neste navegador) ----------
  var VIRTUAL = /obs|virtual|manycam|snap camera|xsplit|droidcam|epoccam|ndi|streamlabs/i;
  function loadDev() { try { return JSON.parse(localStorage.getItem(DEV_KEY)) || {}; } catch (e) { return {}; } }
  function saveDev(p) { try { localStorage.setItem(DEV_KEY, JSON.stringify(p)); } catch (e) { /* ignorar */ } }
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
  // câmera a usar: a escolhida pelo professor; sem escolha, evita câmera virtual (OBS etc.)
  async function resolveCam() {
    var p = loadDev();
    var l = await listDevices();
    if (p.cam && l.cams.some(function (d) { return d.deviceId === p.cam; })) return p.cam;
    if (!l.cams.some(function (d) { return d.label; })) {
      try { var s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach(function (t) { t.stop(); }); l = await listDevices(); } catch (e) { /* ignorar */ }
    }
    var rc = realCam(l.cams);
    return rc ? rc.deviceId : undefined;
  }
  async function resolveMic() {
    var p = loadDev();
    if (!p.mic) return undefined;
    var l = await listDevices();
    return l.mics.some(function (d) { return d.deviceId === p.mic; }) ? p.mic : undefined;
  }

  var S = null;            // última foto da aula enviada pelo servidor
  var offset = 0;          // diferença entre o relógio do servidor e o deste computador
  var ws = null;
  var views = new Map();   // roomId -> RoomView (uma conexão LiveKit por sala)
  var ui = {
    n: null, confirm: null, warn: '', net: false, watch: new Set(),
    camRooms: new Set(),     // salas em que o professor aparece na câmera (pode ser várias ao mesmo tempo)
    joined: new Set(),       // salas em que o professor está "dentro" (entrou pelo botão Entrar na sala)
    kickPid: null,
    lobbyOn: false, lobbyWatch: false, lobbyListen: true, lobbyTalk: false, lobbyCam: false,   // sala de espera
    sel: new Set(),          // salas escolhidas para transmissão (microfone, tela, mensagem)
    share: null,             // { stream, rooms:Set } quando a tela está sendo compartilhada
    chat: {},                // roomId -> mensagens
    unread: {},              // roomId -> não lidas
    chatRoom: null,          // sala aberta no chat
    round: -1, fetched: -1, emInit: false, keep: null
  };

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
      '<div class="field"><label class="lbl" for="pname">Seu nome (aparece nas mensagens do chat)</label><input class="input" id="pname" maxlength="30" autocomplete="given-name" value="' + esc(profName) + '" placeholder="Ex.: Gabriel"></div>' +
      '<div class="field"><label class="lbl" for="pw">Senha</label><input class="input" id="pw" type="password" autocomplete="current-password" required></div>' +
      '<div class="msg err" id="lerr" role="alert" hidden></div>' +
      '<button class="btn btn-primary" type="submit">Entrar</button></form>';
    $('login').addEventListener('submit', function (e) {
      e.preventDefault();
      $('lerr').hidden = true;
      A.api('POST', '/api/professor/login', { password: $('pw').value }).then(function (r) {
        saveName($('pname').value);
        token = r.token;
        try { localStorage.setItem(TOKEN_KEY, token); } catch (e2) { /* ignorar */ }
        boot();
      }, function (ex) { $('lerr').textContent = ex.message; $('lerr').hidden = false; });
    });
    setTimeout(function () { var p = $(profName ? 'pw' : 'pname'); if (p) p.focus(); }, 50);
  }

  // ======================================================== lista de aulas
  var PHASE_TEXT = { lobby: 'Aberta para entrada', r1: 'Rodada 1 ao vivo', between: 'Intervalo', r2: 'Rodada 2 ao vivo', closing: 'Encerramento', done: 'Encerrada' };

  function viewList() {
    app.innerHTML = '<p class="small">Carregando…</p>';
    T('GET', '/api/professor/classes').then(function (r) {
      var d = new Date();
      var def = 'Aula de conversação · ' + String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
      app.innerHTML = '<div class="topbar"><div><h1>Salas de Conversação</h1><p class="sub">Painel do professor</p></div><span class="actions"><a class="btn btn-sm" href="/relatorios">Relatórios</a><button class="btn btn-sm" data-act="logout" type="button">Sair</button></span></div>' +
        '<div id="set-slot"></div>' +
        (r.livekit ? '' : '<div class="msg err">O servidor ainda não tem o LiveKit configurado (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET). Sem isso a aula não consegue começar.</div>') +
        '<form class="card" id="new-class" novalidate><h2>Nova aula</h2>' +
        '<p class="small">Cada aula tem um link só dela. Poste o link da aula de quinta para os alunos de quinta, o da sexta para os de sexta.</p>' +
        '<div class="form-row"><div class="field"><label class="lbl" for="c-title">Nome da aula</label><input class="input" id="c-title" maxlength="60" value="' + esc(def) + '"></div>' +
        '<div class="field"><label class="lbl" for="c-min">Min. por rodada</label><input class="input" id="c-min" type="number" min="1" max="30" value="15"></div></div>' +
        '<div class="msg err" id="c-err" role="alert" hidden></div>' +
        '<div><button class="btn btn-primary" type="submit">Criar aula e gerar link</button></div></form>' +
        '<div class="classes">' + (r.classes.length ? r.classes.map(classRow).join('') : '<p class="empty">Nenhuma aula criada ainda.</p>') + '</div>';
      mountSettings();
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
      '<a class="btn btn-primary btn-sm" href="/professor/' + c.id + '">Abrir painel</a>' +
      (c.startedAt ? '<a class="btn btn-sm" href="/relatorio/' + c.id + '" target="_blank" rel="noopener">Relatório</a>' : '') + '</div></div>';
  }

  // ======================================================== painel da aula
  var netTimer = null;
  function viewPanel() {
    app.innerHTML = '<p class="small">Conectando à aula…</p>';
    ws = A.connectWS('/ws?role=teacher&class=' + encodeURIComponent(classId) + '&token=' + encodeURIComponent(token) + '&tid=' + tid, {
      onOpen: function () { clearTimeout(netTimer); ui.fetched = -1; if (S) fetchChat(); if (ui.net) { ui.net = false; render(); } },
      onMessage: function (m) {
        if (m.type === 'state') { S = m.data; A.setPhotos(classId, S.photos); offset = S.now - Date.now(); onState(); }
        else if (m.type === 'chat') addChatMsg(m.roomId, m.msg);
      },
      onClose: function (e) {
        if (e.code === 4001) logout('Sessão expirada. Entre de novo.');
        else if (e.code === 4004) app.innerHTML = '<div class="card narrow"><h1>Aula não encontrada</h1><p>O servidor não conhece esta aula. Se ele foi reiniciado sem disco persistente, as aulas se perdem.</p><a class="btn btn-primary" href="/professor">Voltar às aulas</a></div>';
        else if (S) { clearTimeout(netTimer); netTimer = setTimeout(function () { ui.net = true; render(); }, 3000); }
      }
    });
  }

  function onState() {
    if (S.round !== ui.round) {                     // nova rodada: salas novas, chat novo
      var lobbyChat = ui.chat.lobby; var lobbyUnread = ui.unread.lobby;
      ui.round = S.round; ui.chat = {}; ui.unread = {}; ui.sel.clear(); ui.fetched = -1;
      if (ui.chatRoom !== 'lobby') ui.chatRoom = null;
      if (lobbyChat) ui.chat.lobby = lobbyChat;
      if (lobbyUnread) ui.unread.lobby = lobbyUnread;
    }
    if (!isLive()) { if (ui.share) stopShareQuiet(); if (ui.chatRoom !== 'lobby') ui.chatRoom = null; ui.camRooms.clear(); ui.sel.clear(); ui.joined.clear(); }
    if (S.phase === 'done') { ui.lobbyOn = false; ui.chatRoom = null; }
    ui.camRooms.forEach(function (id) { if (!S.rooms.some(function (r) { return r.id === id; })) ui.camRooms.delete(id); });
    ui.joined.forEach(function (id) { if (!S.rooms.some(function (r) { return r.id === id; })) ui.joined.delete(id); });
    var ids = new Set(S.rooms.map(function (r) { return r.id; }));
    ui.sel.forEach(function (id) { if (!ids.has(id)) ui.sel.delete(id); });
    if (ui.share) { ui.share.rooms.forEach(function (id) { if (!ids.has(id)) ui.share.rooms.delete(id); }); if (!ui.share.rooms.size) stopShareQuiet(); }
    syncViews();
    applyHear();
    render();
    if (ui.fetched !== S.round) fetchChat();
    ensureEm();
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
    if (pid === '__me') return;
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

  // Prévia da sua própria câmera dentro da sala (espelhada), para você ver o que os alunos veem
  var selfVids = new Map();
  function selfTileHTML(roomId) {
    return '<div class="tile me lv-misto" data-pid="__me" data-room="' + roomId + '"><span class="avatar">V</span><span class="slot" data-self="1" data-room="' + roomId + '"></span><span class="nm">Você</span></div>';
  }
  function mountSelf() {
    var seen = new Set();
    document.querySelectorAll('.slot[data-self]').forEach(function (slot) {
      var id = slot.getAttribute('data-room');
      seen.add(id);
      var v = selfVids.get(id);
      if (!v) { v = document.createElement('video'); v.muted = true; v.autoplay = true; v.playsInline = true; selfVids.set(id, v); }
      if (camShared.stream && v.srcObject !== camShared.stream) v.srcObject = camShared.stream;
      if (v.parentNode !== slot) slot.appendChild(v);
      if (camShared.stream) { slot.parentNode.classList.add('has-video'); var pp = v.play(); if (pp && pp.catch) pp.catch(function () { /* ignorar */ }); }
    });
    selfVids.forEach(function (v, id) { if (!seen.has(id)) { v.srcObject = null; v.remove(); selfVids.delete(id); } });
  }

  // problemas de conexão do professor (entram no relatório)
  function reportProblem(kind) {
    T('POST', '/api/professor/classes/' + classId + '/problem', { kind: kind }).catch(function () { /* ignorar */ });
  }

  // Uma única captura da câmera serve a todas as salas: cada sala recebe uma cópia da imagem.
  var camShared = { stream: null, pending: null };
  function acquireCam() {
    var cur = camShared.stream && camShared.stream.getVideoTracks()[0];
    if (cur && cur.readyState === 'live') return Promise.resolve(camShared.stream);
    if (camShared.pending) return camShared.pending;
    camShared.pending = (async function () {
      var id = await resolveCam();
      var base = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } };
      var st;
      try { st = await navigator.mediaDevices.getUserMedia({ video: id ? Object.assign({ deviceId: { exact: id } }, base) : base }); }
      catch (e) { if (!id) throw e; st = await navigator.mediaDevices.getUserMedia({ video: base }); }
      camShared.stream = st;
      return st;
    })();
    var clear = function () { camShared.pending = null; };
    camShared.pending.then(clear, clear);
    return camShared.pending;
  }
  function releaseCamIfUnused() {
    var used = false;
    views.forEach(function (v) { if (!v.dead && v.camOn) used = true; });
    if (used || !camShared.stream) return;
    camShared.stream.getTracks().forEach(function (t) { t.stop(); });
    camShared.stream = null;
  }
  function restartCam() {                       // trocou de câmera nas configurações
    if (camShared.stream) { camShared.stream.getTracks().forEach(function (t) { t.stop(); }); camShared.stream = null; }
    views.forEach(function (v) { if (v.camOn && v.connected) v.setCam(true, true); });
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
      this.shareStream = null;
      this.shareTrack = null;
      this.camOn = false;
      this.camTrack = null;
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
        reportProblem('video-caiu');
        clearTimeout(self.rt);
        self.rt = setTimeout(function () { self.connect(); }, 3000);
      });
      room.connect(S.lk.url, this.token, { autoSubscribe: false }).then(function () {
        if (self.dead) { room.disconnect(); return; }
        self.connected = true;
        room.remoteParticipants.forEach(function (p) {
          p.trackPublications.forEach(function (pub) { self.onPub(pub, p); });
        });
        self.shareTrack = null;
        self.camTrack = null;
        if (self.camOn) self.setCam(true);
        if (self.talking) self.setTalking(true);
        if (self.shareStream) self.setShare(self.shareStream);
      }, function () {
        if (self.dead) return;
        reportProblem('video-falhou');
        clearTimeout(self.rt);
        self.rt = setTimeout(function () { self.connect(); }, 3000);
      });
    }
    onPub(pub, p) {
      if (isProf(p.identity)) return;
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
      this.chain = this.chain.then(async function () {
        if (!self.connected) return null;
        var lp = self.room.localParticipant;
        if (on) {
          var mid = await resolveMic();
          try { return await lp.setMicrophoneEnabled(true, mid ? { deviceId: mid } : undefined); }
          catch (e) { if (mid) return lp.setMicrophoneEnabled(true); throw e; }
        }
        var pub = lp.getTrackPublication(LK.Track.Source.Microphone);
        return pub && pub.track ? lp.unpublishTrack(pub.track, true) : null;
      }).catch(function () {
        if (on) { ui.warn = 'Não consegui usar o microfone. Libere a permissão do navegador (cadeado ao lado do endereço) e tente de novo.'; render(); }
      });
    }
    setCam(on, force) {
      var self = this;
      this.camOn = on;
      this.chain = this.chain.then(async function () {
        if (!self.connected) return null;
        var lp = self.room.localParticipant;
        if (on && !force && self.camTrack && self.camTrack.mediaStreamTrack && self.camTrack.mediaStreamTrack.readyState === 'live') return null; // já está no ar
        if (self.camTrack) {
          var old = self.camTrack; self.camTrack = null;
          try { await lp.unpublishTrack(old, true); } catch (e) { /* ignorar */ }
          try { old.mediaStreamTrack.stop(); } catch (e) { /* ignorar */ }
        }
        if (!on) { releaseCamIfUnused(); return null; }
        var stream = await acquireCam();
        mountSelf();
        var src = stream.getVideoTracks()[0];
        var lt = new LK.LocalVideoTrack(src.clone(), undefined, true);
        await lp.publishTrack(lt, { source: LK.Track.Source.Camera, name: 'camera', simulcast: false, videoEncoding: { maxBitrate: 450000, maxFramerate: 24 } });
        self.camTrack = lt;
        return null;
      }).catch(function () {
        if (on) {
          ui.camRooms.clear(); ui.lobbyCam = false;
          ui.warn = 'Não consegui usar a sua câmera. Libere a permissão do navegador (cadeado ao lado do endereço) e tente de novo.';
          syncViews(); applyHear(); render();
        }
      });
    }
    setShare(stream) {
      var self = this;
      this.shareStream = stream;
      this.chain = this.chain.then(async function () {
        if (!self.connected) return;
        var lp = self.room.localParticipant;
        if (self.shareTrack) {
          var old = self.shareTrack; self.shareTrack = null;
          try { await lp.unpublishTrack(old, true); } catch (e) { /* ignorar */ }
        }
        var src = self.shareStream && self.shareStream.getVideoTracks()[0];
        if (!src || src.readyState === 'ended') return;
        var n = ui.share ? Math.max(1, ui.share.rooms.size) : 1;
        var bps = Math.round(Math.min(1500000, Math.max(350000, 4000000 / n)));
        var lt = new LK.LocalVideoTrack(src.clone(), undefined, true);
        await lp.publishTrack(lt, { source: LK.Track.Source.ScreenShare, name: 'tela', simulcast: false, videoEncoding: { maxBitrate: bps, maxFramerate: 10 } });
        self.shareTrack = lt;
      }).catch(function () {
        ui.warn = 'Não consegui enviar a tela para a sala. Tente parar e compartilhar de novo.'; render();
      });
    }
    destroy() {
      this.dead = true;
      setTimeout(releaseCamIfUnused, 0);
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
    var bm = new Set(S.bmic || []);
    if (live) S.rooms.forEach(function (r) {
      if (r.lk && (ui.watch.has(r.id) || (S.hear && S.hear.roomId === r.id) || bm.has(r.id) || (ui.share && ui.share.rooms.has(r.id)) || ui.camRooms.has(r.id))) want.set(r.id, r);
    });
    if (ui.lobbyOn && S.lobby && S.phase !== 'done') want.set('lobby', { id: 'lobby', lk: S.lobby });
    views.forEach(function (v, id) {
      var r = want.get(id);
      if (!r || r.lk.room !== v.name) { v.destroy(); views.delete(id); }
    });
    want.forEach(function (r, id) { if (!views.has(id)) views.set(id, new RoomView(r)); });
  }
  function applyHear() {
    var h = S && S.hear;
    var bm = new Set((S && S.bmic) || []);
    views.forEach(function (v, id) {
      if (id === 'lobby') {
        if (v.watching !== ui.lobbyWatch) v.setWatching(ui.lobbyWatch);
        if (v.listening !== ui.lobbyListen) v.setListening(ui.lobbyListen);
        if (v.talking !== ui.lobbyTalk) v.setTalking(ui.lobbyTalk);
        if (v.camOn !== ui.lobbyCam) v.setCam(ui.lobbyCam);
        return;
      }
      var w = ui.watch.has(id);
      if (v.watching !== w) v.setWatching(w);
      var l = !!h && h.roomId === id;
      if (v.listening !== l) v.setListening(l);
      var t = (l && h.mode === 'talk') || bm.has(id);
      if (v.talking !== t) v.setTalking(t);
      var cm = ui.camRooms.has(id);
      if (v.camOn !== cm) v.setCam(cm);
      var sh = ui.share && ui.share.rooms.has(id) ? ui.share.stream : null;
      if (v.shareStream !== sh) v.setShare(sh);
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
      return T('GET', '/api/professor/classes/' + classId + '?tid=' + tid).then(function (d) { S = d; A.setPhotos(classId, S.photos); offset = S.now - Date.now(); onState(); }, function () { render(); });
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
  var PHASE_LABEL = { lobby: 'Sala de espera', r1: 'Rodada 1 de 2', between: 'Intervalo', r2: 'Rodada 2 de 2', closing: 'Encerramento', done: 'Aula encerrada' };
  function isLive() { return S.phase === 'r1' || S.phase === 'r2'; }
  function isPlanning() { return S.phase === 'lobby' || S.phase === 'between'; }

  function levelOf(r, by) {
    var set = new Set();
    r.members.forEach(function (p) { if (by[p] && !by[p].listener) set.add(by[p].level); });
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
    return '<div class="pchip ' + A.LEVEL_CLS[s.level] + (s.listener ? ' ls' : '') + (s.online ? '' : ' offline') + '" draggable="true" data-pid="' + s.pid + '">' +
      (s.listener ? '<span class="lsbar">Ouvinte</span>' : '') +
      A.avatar(s.name, s.pid) +
      '<span class="pn" title="' + esc(s.name) + ' (' + A.LEVEL_NAME[s.level] + ')">' + esc(s.name) + '</span>' +
      '<span class="st ' + (s.online ? 'on' : 'off') + '" title="' + (s.online ? 'online' : 'offline') + '"></span>' +
      mvSelect(s, roomId) +
      '<button class="kick" data-act="ask-kick" data-pid="' + s.pid + '" title="Excluir da aula" aria-label="Excluir ' + esc(s.name) + ' da aula" type="button">&times;</button>' +
      '</div>';
  }
  function tileHTML(r, s) {
    return '<div class="tile ' + A.LEVEL_CLS[s.level] + (s.listener ? ' ls' : '') + (s.online ? '' : ' offline') + '" draggable="true" data-pid="' + s.pid + '" data-room="' + r.id + '">' +
      (s.listener ? '<span class="lsbar">Ouvinte</span>' : '') +
      A.avatar(s.name, s.pid) +
      '<span class="slot" data-room="' + r.id + '" data-pid="' + s.pid + '"></span>' +
      '<span class="nm" title="' + esc(s.name) + '">' + esc(s.name) + (s.online ? '' : ' (offline)') + '</span>' +
      '<span class="micoff">' + A.ICON.micoff + '</span>' +
      '<button class="tilemute" data-act="mute" data-pid="' + s.pid + '" title="Desligar o microfone deste aluno" aria-label="Desligar o microfone de ' + esc(s.name) + '" type="button">' + A.ICON.micoff + '</button>' +
      mvSelect(s, r.id) +
      '<button class="kick tilekick" data-act="ask-kick" data-pid="' + s.pid + '" title="Excluir da aula" aria-label="Excluir ' + esc(s.name) + ' da aula" type="button">&times;</button></div>';
  }

  function roomHTML(r, by) {
    var live = isLive();
    var lvl = levelOf(r, by);
    var members = r.members.map(function (p) { return by[p]; }).filter(Boolean);
    var calling = members.some(function (s) { return s.callAt; });
    var listening = !!S.hear && S.hear.roomId === r.id;
    var talking = listening && S.hear.mode === 'talk';
    var bcast = (S.bmic || []).indexOf(r.id) !== -1;
    var sharing = !!ui.share && ui.share.rooms.has(r.id);
    var body;
    var selfTile = ui.camRooms.has(r.id) ? selfTileHTML(r.id) : '';
    if (live) body = (members.length || selfTile) ? '<div class="tiles">' + selfTile + members.map(function (s) { return tileHTML(r, s); }).join('') + '</div>' : '<p class="empty">Sala vazia. Arraste alguém para cá.</p>';
    else body = '<div class="plist">' + (members.length ? members.map(function (s) { return chipHTML(s, r.id); }).join('') : '<span class="empty">Sala vazia. Arraste alguém para cá.</span>') + '</div>';
    var status = '';
    var actions = '';
    if (live) {
      if (talking || bcast) status = '<span class="tag live"><i class="pulse"></i>Seu microfone está aberto</span>';
      else if (calling) status = '<span class="tag call"><i class="pulse"></i>Chamando professor</span>';
      else if (listening) status = '<span class="tag hear"><span class="eq"><i></i><i></i><i></i></span>Ouvindo a sala</span>';
      else status = '<span>Sem áudio</span>';
      if (sharing) status += '<span class="tag share">' + A.ICON.screen + 'Tela compartilhada</span>';
      if (ui.camRooms.has(r.id)) status += '<span class="tag live">' + A.ICON.cam + 'Você está na câmera</span>';
      var un = ui.unread[r.id] || 0;
      var chatBtn = '<button class="btn" data-act="chat-open" data-room="' + r.id + '" aria-pressed="' + (ui.chatRoom === r.id) + '" type="button">' + A.ICON.chat + 'Chat' + (un ? ' <span class="unread">' + un + '</span>' : '') + '</button>';
      if (!ui.joined.has(r.id)) {
        actions = '<div class="room-actions"><button class="btn btn-primary" data-act="room-join" data-room="' + r.id + '" type="button">Entrar na sala</button>' + chatBtn + '</div>';
      } else {
        // esquerda: áudio · direita: vídeo · embaixo: chat e sair
        actions = '<div class="room-actions">' +
          '<button class="btn" data-act="listen" data-room="' + r.id + '" aria-pressed="' + listening + '" type="button">' + A.ICON.head + 'Ouvir</button>' +
          '<button class="btn" data-act="watch" data-room="' + r.id + '" aria-pressed="' + ui.watch.has(r.id) + '" type="button">' + A.ICON.cam + 'Ver vídeo</button>' +
          '<button class="btn btn-live" data-act="talk" data-room="' + r.id + '" aria-pressed="' + talking + '" type="button">' + A.ICON.mic + (talking ? 'Falando' : 'Falar') + '</button>' +
          '<button class="btn" data-act="cam" data-room="' + r.id + '" aria-pressed="' + ui.camRooms.has(r.id) + '" type="button">' + A.ICON.cam + 'Câmera</button>' +
          chatBtn +
          '<button class="btn btn-leave" data-act="room-leave" data-room="' + r.id + '" type="button">Sair da sala</button></div>';
      }
    } else if (!members.length) {
      actions = '<div class="room-actions"><button class="btn btn-sm wide" data-act="remove-room" data-room="' + r.id + '" type="button">Remover sala vazia</button></div>';
    }
    return '<article class="room ' + (lvl ? A.LEVEL_CLS[lvl] : '') + (ui.joined.has(r.id) ? ' joined' : '') + (calling ? ' calling' : '') + (listening ? ' hearing' : '') + '" data-drop="' + r.id + '">' +
      '<div class="room-head"><h3>' + 'Sala ' + r.no + '</h3>' + (live && members.length ? '<button class="btn btn-sm" data-act="mute-room" data-room="' + r.id + '" title="Desligar o microfone de todos os alunos desta sala" type="button">Mutar sala</button>' : '') + '<span class="badge">' + (lvl ? A.LEVEL_NAME[lvl] : 'Vazia') + ' · ' + members.length + '</span></div>' +
      body + (status ? '<div class="room-status">' + status + '</div>' : '') + actions + '</article>';
  }

  // ---------- sala de espera (aluno sem sala) ----------
  function lobbyPeople() {
    var assigned = new Set();
    if (isLive()) S.rooms.forEach(function (r) { r.members.forEach(function (p) { assigned.add(p); }); });
    return S.students.filter(function (s) { return s.online && !assigned.has(s.pid); });
  }
  function lobbyTileHTML(s) {
    return '<div class="tile ' + A.LEVEL_CLS[s.level] + (s.listener ? ' ls' : '') + '" data-pid="' + s.pid + '" data-room="lobby">' +
      (s.listener ? '<span class="lsbar">Ouvinte</span>' : '') +
      A.avatar(s.name, s.pid) +
      '<span class="slot" data-room="lobby" data-pid="' + s.pid + '"></span>' +
      '<span class="nm" title="' + esc(s.name) + '">' + esc(s.name) + '</span>' +
      '<span class="micoff">' + A.ICON.micoff + '</span>' +
      '<button class="tilemute" data-act="mute" data-pid="' + s.pid + '" title="Desligar o microfone deste aluno" aria-label="Desligar o microfone de ' + esc(s.name) + '" type="button">' + A.ICON.micoff + '</button>' + '</div>';
  }
  function lobbyHTML() {
    var people = lobbyPeople();
    var un = ui.unread.lobby || 0;
    var chatBtn = '<button class="btn" data-act="chat-open" data-room="lobby" aria-pressed="' + (ui.chatRoom === 'lobby') + '" type="button">' + A.ICON.chat + 'Chat' + (un ? ' <span class="unread">' + un + '</span>' : '') + '</button>';
    var h = '<section class="lobbycard' + (ui.lobbyOn ? ' on' : '') + '"><div class="room-head"><h3>Sala de espera</h3><span class="badge">' + people.length + ' online</span></div>';
    if (!ui.lobbyOn) {
      h += '<div class="room-actions"><button class="btn btn-primary" data-act="lobby-join" type="button">Entrar na sala de espera</button>' + chatBtn + '</div></section>';
      return h;
    }
    h += ((people.length || ui.lobbyCam) ? '<div class="tiles lobby-tiles">' + (ui.lobbyCam ? selfTileHTML('lobby') : '') + people.map(lobbyTileHTML).join('') + '</div>' : '<p class="empty">Ninguém na sala de espera agora.</p>');
    var status = ui.lobbyTalk ? '<span class="tag live"><i class="pulse"></i>Seu microfone está aberto para a sala de espera</span>'
      : (ui.lobbyListen ? '<span class="tag hear"><span class="eq"><i></i><i></i><i></i></span>Ouvindo a sala de espera</span>' : '<span>Sem áudio</span>');
    if (ui.lobbyCam) status += '<span class="tag live">' + A.ICON.cam + 'Você está na câmera</span>';
    h += '<div class="room-status">' + status + '</div><div class="room-actions">' +
      '<button class="btn" data-act="lobby-listen" aria-pressed="' + ui.lobbyListen + '" type="button">' + A.ICON.head + 'Ouvir</button>' +
      '<button class="btn" data-act="lobby-watch" aria-pressed="' + ui.lobbyWatch + '" type="button">' + A.ICON.cam + 'Ver vídeo</button>' +
      '<button class="btn btn-live" data-act="lobby-talk" aria-pressed="' + ui.lobbyTalk + '" type="button">' + A.ICON.mic + (ui.lobbyTalk ? 'Falando' : 'Falar') + '</button>' +
      '<button class="btn" data-act="lobby-cam" aria-pressed="' + ui.lobbyCam + '" type="button">' + A.ICON.cam + 'Câmera</button>' +
      chatBtn +
      '<button class="btn btn-leave" data-act="lobby-leave" type="button">Sair da sala</button></div></section>';
    return h;
  }

  function confirmText() {
    if (ui.confirm === 'start') {
      var n = S.students.length;
      if (S.phase === 'between') return 'Iniciar a rodada 2 com as salas abaixo? Cada aluno será levado para a nova sala.';
      return 'Ao iniciar, a aula é trancada e nenhum aluno novo poderá entrar. Iniciar agora com ' + n + ' aluno' + (n === 1 ? '' : 's') + '?';
    }
    if (ui.confirm === 'end-round') return S.phase === 'r2' ? 'Encerrar a rodada 2? Todos voltam para a sala de espera e a aula termina sozinha em ' + (S.closingMinutes || 5) + ' minutos (você pode encerrar antes).' : 'Encerrar a rodada 1 agora? Todos voltam para a sala de espera.';
    if (ui.confirm === 'kick') {
      var ks = S.students.find(function (x) { return x.pid === ui.kickPid; });
      return 'Excluir ' + (ks ? ks.name : 'este aluno') + ' da aula? Ele será desconectado e, para voltar, precisará entrar de novo pelo link.';
    }
    if (ui.confirm === 'end-class') return 'Encerrar a aula agora? Todos os alunos verão a mensagem final e serão desconectados.';
    return '';
  }

  function temasHTML() {
    var t = ui.temas || {};
    var items = [t.t1, t.t2].filter(Boolean);
    if (!items.length) return '';
    return '<div class="temas"><span class="lbl-t">Temas sugeridos</span>' + items.map(function (x) { return '<span class="tema">' + esc(x) + '</span>'; }).join('') + '</div>';
  }
  function loadTemas() {
    fetch('/api/temas').then(function (r) { return r.json(); }).then(function (t) {
      var a = JSON.stringify(t), b = JSON.stringify(ui.temas || {});
      ui.temas = t;
      if (a !== b && S && !ui.confirm) render();
    }).catch(function () { /* ignorar */ });
  }
  loadTemas();
  setInterval(loadTemas, 60000);

  function render() {
    if (!S) return;
    var fa = document.activeElement;
    ui.keep = fa && /^(bc-text|em-text|em-url|em-label|dock-in)$/.test(fa.id) ? { id: fa.id, s: fa.selectionStart, e: fa.selectionEnd } : null;
    var by = {};
    S.students.forEach(function (s) { by[s.pid] = s; });
    var assigned = new Set();
    S.rooms.forEach(function (r) { r.members.forEach(function (p) { assigned.add(p); }); });
    var unassigned = S.students.filter(function (s) { return !assigned.has(s.pid); });
    var live = isLive();
    var planning = isPlanning();
    var url = location.origin + '/aula/' + S.id;
    var online = S.students.filter(function (s) { return s.online; }).length;
    var counts = { basico: 0, intermediario: 0, ouvinte: 0 };
    S.students.forEach(function (s) { counts[s.listener ? 'ouvinte' : s.level]++; });

    var main = { lobby: ['Iniciar aula', 'start'], between: ['Iniciar rodada 2', 'start'], r1: ['Encerrar rodada 1', 'end-round'], r2: ['Encerrar rodada 2', 'end-round'], closing: ['Encerrar a aula', 'end-class'] }[S.phase];
    var h = '<header class="topbar"><div><p class="small"><a href="/professor">&larr; Aulas</a></p><h1>' + esc(S.title) + '</h1>' +
      '<div class="linkrow" style="margin-top:8px"><input class="input" readonly value="' + esc(url) + '" aria-label="Link da aula para os alunos"><button class="btn btn-sm" data-act="copy-link" data-url="' + esc(url) + '" type="button">' + A.ICON.link + 'Copiar link</button><a class="btn btn-sm" href="/relatorio/' + S.id + '" target="_blank" rel="noopener">Relatório</a></div>' + temasHTML() + '</div>' +
      '<div class="clock"><div><div class="phase">' + PHASE_LABEL[S.phase] + '</div><div class="timer idle" id="p-timer">' + A.mmss(S.roundMinutes * 60) + '</div><div class="bar" aria-hidden="true"><i id="p-bar"></i></div></div>' +
      (main ? '<button class="btn btn-primary" data-act="main" type="button">' + main[0] + '</button>' : '') + '</div></header>';

    h += '<div class="statsrow"><div class="stats"><span><b>' + S.students.length + '</b> alunos (' + online + ' online)</span>' +
      '<span class="lv-basico"><i class="dot"></i><b>' + counts.basico + '</b> Básico</span>' +
      '<span class="lv-inter"><i class="dot"></i><b>' + counts.intermediario + '</b> Intermediário</span>' +
      '<span class="lv-ouv"><i class="dot"></i><b>' + counts.ouvinte + '</b> Ouvinte' + (counts.ouvinte === 1 ? '' : 's') + '</span>' +
      (S.rooms.length ? '<span><b>' + S.rooms.length + '</b> salas</span>' : '') +
      (unassigned.length ? '<span><b>' + unassigned.length + '</b> sem sala</span>' : '') + '</div>' +
      '<span class="actions">' +
      '' +
      (planning || live ? '<button class="btn btn-sm" data-act="ask-end-class" type="button">Encerrar aula</button>' : '') + '</span></div>';

    if (ui.net) h += '<div class="msg info" role="status">Conexão instável. Reconectando…</div>';
    if (ui.warn) h += '<div class="msg err" role="alert">' + esc(ui.warn) + '</div>';
    if (ui.confirm) h += '<div class="confirm" role="alert"><p>' + esc(confirmText()) + '</p><button class="btn btn-primary" data-act="confirm-yes" type="button">Confirmar</button><button class="btn" data-act="confirm-no" type="button">Cancelar</button></div>';

    if (S.phase === 'done') {
      h += '<div class="card"><h2>Aula encerrada</h2><p>' + S.students.length + ' aluno' + (S.students.length === 1 ? '' : 's') + ' participaram. Você pode criar uma nova aula na lista.</p><div><a class="btn btn-primary" href="/professor">Voltar às aulas</a></div></div><div id="em-slot"></div>';
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

    if (S.phase === 'closing') {
      h += '<div class="card"><h2>Encerramento</h2><p>Todos os alunos voltaram para a sala de espera. A aula termina sozinha quando a contagem chegar a zero, ou antes, se você clicar em “Encerrar a aula”. Aproveite para falar com todos e se despedir.</p></div>' +
        lobbyHTML(by) + '<div id="set-slot"></div><div id="em-slot"></div>';
      app.innerHTML = h;
      postRender();
      return;
    }

    h += '<div class="toolbar">';
    if (planning) {
      h += '<span class="lbl-t" style="margin:0">Salas</span><span class="stepper"><button class="btn btn-sm" data-act="n-minus" type="button" aria-label="Menos salas">&minus;</button><output>' + (ui.n || 'auto') + '</output><button class="btn btn-sm" data-act="n-plus" type="button" aria-label="Mais salas">+</button></span>' +
        '<button class="btn" data-act="plan" type="button">Distribuir automaticamente</button>';
    }
    h += '<button class="btn" data-act="add-room" type="button">+ Sala vazia</button></div>';
    if (planning && S.phase === 'between' && S.repeats) {
      h += '<p class="hint">' + S.repeats + ' par' + (S.repeats > 1 ? 'es' : '') + ' repetido' + (S.repeats > 1 ? 's' : '') + ' da rodada 1 (há poucos alunos em um dos níveis).</p>';
    }

    var duo = '';
    if (!live || unassigned.some(function (u) { return u.online; })) duo += lobbyHTML(by);
    if (planning || unassigned.length) {
      duo += '<section class="zone bucket" data-drop="none"><h3>Sem sala <span class="badge lv-misto">' + unassigned.length + '</span></h3><div class="plist">' +
        (unassigned.length ? unassigned.map(function (s) { return chipHTML(s, null); }).join('') : '<span class="empty">Todos os alunos estão em salas. Arraste um aluno para cá para tirá-lo de uma sala.</span>') + '</div></section>';
    }
    if (duo) h += '<div class="duo">' + duo + '</div>';
    h += '<div class="board">' + S.rooms.map(function (r) { return roomHTML(r, by); }).join('') + '</div>';
    if (live) h += '<div id="bc-slot"></div>';
    h += '<div id="set-slot"></div><div id="em-slot"></div>';

    app.innerHTML = h;
    postRender();
  }

  function postRender() {
    views.forEach(function (v) {
      v.videos.forEach(function (_el, pid) { mountVideo(v, pid); });
      paintAll(v);
    });
    var bslot = $('bc-slot');
    if (bslot) { ensureBc(); renderBcTop(); bslot.appendChild(bcEl); }
    mountSelf();
    var eslot = $('em-slot');
    if (eslot) { ensureEm(); eslot.appendChild(emEl); }
    mountSettings();
    if (ui.keep) {
      var k = $(ui.keep.id);
      if (k) { try { k.focus({ preventScroll: true }); if (k.setSelectionRange && ui.keep.s != null) k.setSelectionRange(ui.keep.s, ui.keep.e); } catch (e) { /* ignorar */ } }
      ui.keep = null;
    }
    renderPill();
    tick();
  }

  // ---------- meu nome, câmera e microfone ----------
  var setEl = null;
  var prevStream = null;
  function ensureSettings() {
    if (setEl) return;
    setEl = document.createElement('details');
    setEl.className = 'em';
    setEl.innerHTML = '<summary>Meu nome, câmera e microfone</summary><div class="em-body">' +
      '<label class="lbl-t" for="set-name">Seu nome (aparece nas mensagens do chat)</label><input class="input" id="set-name" maxlength="30" placeholder="Ex.: Gabriel">' +
      '<label class="lbl-t" for="set-cam">Câmera que aparece para os alunos</label><select class="input" id="set-cam"></select>' +
      '<label class="lbl-t" for="set-mic">Microfone</label><select class="input" id="set-mic"></select>' +
      '<video id="set-prev" class="prev" muted playsinline hidden></video>' +
      '<p class="small" id="set-hint">Ao abrir esta seção, o navegador pede permissão e mostra a sua câmera. A escolha fica salva neste navegador.</p></div>';
    setEl.querySelector('#set-name').value = profName;
    setEl.querySelector('#set-name').addEventListener('change', function () { saveName(this.value); this.value = profName; });
    setEl.addEventListener('toggle', function () { if (setEl.open) startPrev(); else stopPrev(); });
    setEl.querySelector('#set-cam').addEventListener('change', function () {
      var p = loadDev(); p.cam = this.value; saveDev(p);
      restartCam();
      startPrev();
    });
    setEl.querySelector('#set-mic').addEventListener('change', function () {
      var p = loadDev(); p.mic = this.value; saveDev(p);
      views.forEach(function (v) { if (v.talking && v.connected) v.room.switchActiveDevice('audioinput', p.mic).catch(function () { /* ignorar */ }); });
    });
  }
  function mountSettings() {
    var slot = $('set-slot');
    if (!slot) return;
    ensureSettings();
    if (setEl.parentNode !== slot) slot.appendChild(setEl);
  }
  function stopPrev() {
    if (prevStream) { prevStream.getTracks().forEach(function (t) { t.stop(); }); prevStream = null; }
    var v = setEl && setEl.querySelector('#set-prev');
    if (v) { v.srcObject = null; v.hidden = true; }
  }
  function fillSel(sel, list, current, label) {
    sel.innerHTML = '';
    list.forEach(function (d, i) {
      var o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || (label + ' ' + (i + 1));
      if (d.deviceId === current) o.selected = true;
      sel.appendChild(o);
    });
    sel.disabled = !list.length;
  }
  async function startPrev() {
    stopPrev();
    var hint = setEl.querySelector('#set-hint');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { hint.textContent = 'Este navegador não permite usar a câmera aqui.'; return; }
    try {
      var camId = await resolveCam();
      var micId = await resolveMic();
      var stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: camId ? { deviceId: { exact: camId } } : true, audio: micId ? { deviceId: { exact: micId } } : true });
      } catch (e) { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); }
      if (!setEl.open) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      prevStream = stream;
      var v = setEl.querySelector('#set-prev');
      v.srcObject = stream; v.hidden = false;
      v.play().catch(function () { /* ignorar */ });
      var l = await listDevices();
      var cur = stream.getVideoTracks()[0] && stream.getVideoTracks()[0].getSettings().deviceId;
      var curMic = stream.getAudioTracks()[0] && stream.getAudioTracks()[0].getSettings().deviceId;
      fillSel(setEl.querySelector('#set-cam'), l.cams, cur, 'Câmera');
      fillSel(setEl.querySelector('#set-mic'), l.mics, curMic, 'Microfone');
      hint.textContent = 'Esta é a câmera que os alunos verão. Escolha outra na lista se não for a certa; a escolha fica salva.';
    } catch (e) {
      hint.textContent = 'Não consegui acessar a câmera. Libere a permissão no cadeado ao lado do endereço e abra esta seção de novo.';
    }
  }

  // ---------- painel de transmissão (selecionar salas, microfone, tela, mensagem) ----------
  var bcEl = null;
  function ensureBc() {
    if (bcEl) return;
    bcEl = document.createElement('details');
    bcEl.className = 'bcast em';
    bcEl.open = true;
    bcEl.innerHTML = '<summary>Transmissão do professor</summary><div id="bc-top"></div>' +
      '<form id="bc-form" class="bc-step" autocomplete="off"><div class="bc-step-h"><span class="num">3</span><b>Envie uma mensagem</b><span class="small">aparece no chat dos alunos</span></div>' +
      '<div class="bc-form"><input class="input" id="bc-text" maxlength="300" placeholder="Mensagem do professor para as salas…" aria-label="Mensagem do professor">' +
      '<button class="btn btn-primary" type="submit" data-send="sel" id="bc-send-sel">Enviar às selecionadas</button>' +
      '<button class="btn" type="button" data-act="bc-send-all">Enviar a todas</button></div></form>';
    bcEl.querySelector('#bc-form').addEventListener('submit', function (e) { e.preventDefault(); sendBroadcast('sel'); });
  }
  function bcCard(icon, title, active, count, onAct, offAct, selAct, n) {
    var body = active
      ? '<button class="btn btn-live" aria-pressed="true" data-act="' + offAct + '" type="button">Parar (' + count + ' sala' + (count === 1 ? '' : 's') + ')</button>'
      : '<button class="btn" data-act="' + onAct + '" type="button">Todas as salas</button><button class="btn"' + (n ? '' : ' disabled') + ' data-act="' + selAct + '" type="button">Selecionadas' + (n ? ' (' + n + ')' : '') + '</button>';
    return '<div class="bc-card' + (active ? ' on' : '') + '"><div class="bc-card-h">' + icon + '<b>' + title + '</b></div><div class="bc-card-b">' + body + '</div></div>';
  }
  function renderBcTop() {
    if (!bcEl || !S) return;
    var n = ui.sel.size;
    var total = S.rooms.length;
    var mic = (S.bmic || []).length;
    var sh = ui.share ? ui.share.rooms.size : 0;
    var cm = ui.camRooms.size;
    var h = '<div class="bc-title"><span class="small">Enviar para várias salas ao mesmo tempo. Microfone, tela e câmera usam minutos do LiveKit enquanto estiverem ligados.</span></div>' +
      '<div class="bc-step"><div class="bc-step-h"><span class="num">1</span><b>Escolha as salas</b><span class="small">' + n + ' de ' + total + ' selecionada' + (n === 1 ? '' : 's') + '</span><span class="spacer"></span>' +
      '<button class="btn btn-sm" data-act="sel-all" type="button">Todas</button><button class="btn btn-sm" data-act="sel-none" type="button">Nenhuma</button></div>' +
      '<div class="bc-rooms">' + S.rooms.map(function (r) {
        return '<label class="bc-chip' + (ui.sel.has(r.id) ? ' on' : '') + '"><input type="checkbox" data-sel="' + r.id + '"' + (ui.sel.has(r.id) ? ' checked' : '') + '> Sala ' + r.no + '</label>';
      }).join('') + '</div></div>' +
      '<div class="bc-step"><div class="bc-step-h"><span class="num">2</span><b>Compartilhe</b></div><div class="bc-cards">' +
      bcCard(A.ICON.mic, 'Microfone', mic > 0, mic, 'bmic-all', 'bmic-off', 'bmic-sel', n) +
      bcCard(A.ICON.screen, 'Tela', sh > 0, sh, 'share-all', 'share-stop', 'share-sel', n) +
      bcCard(A.ICON.cam, 'Câmera', cm > 0, cm, 'cam-all', 'cam-off', 'cam-sel', n) + '</div></div>';
    bcEl.querySelector('#bc-top').innerHTML = h;
    bcEl.querySelector('#bc-send-sel').disabled = !n;
  }
  function selectedIds() { return S.rooms.map(function (r) { return r.id; }).filter(function (id) { return ui.sel.has(id); }); }
  function sendBroadcast(mode) {
    var inp = bcEl.querySelector('#bc-text');
    var text = inp.value.trim();
    if (!text) return;
    var ids = mode === 'all' ? 'all' : selectedIds();
    if (mode !== 'all' && !ids.length) return;
    inp.value = '';
    act({ action: 'chat', roomIds: ids, text: text, name: profName });
  }
  function startShare(ids) {
    if (!ids.length) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      ui.warn = 'Este navegador não permite compartilhar a tela. Use o Chrome ou o Edge no computador.'; render(); return;
    }
    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 }, width: { max: 1600 }, height: { max: 900 } }, audio: false }).then(function (stream) {
      var track = stream.getVideoTracks()[0];
      ui.share = { stream: stream, rooms: new Set(ids) };
      track.addEventListener('ended', function () { if (ui.share && ui.share.stream === stream) stopShare(); });
      syncViews(); applyHear(); render();
    }, function (e) {
      if (e && e.name !== 'NotAllowedError') { ui.warn = 'Não consegui compartilhar a tela.'; render(); }
    });
  }
  function stopShareQuiet() {
    if (!ui.share) return;
    var st = ui.share.stream;
    ui.share = null;
    applyHear();
    try { st.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignorar */ }
    syncViews();
  }
  function stopShare() { stopShareQuiet(); render(); }
  function setBmic(ids) {
    S.bmic = ids;
    startAudioAll();
    syncViews(); applyHear(); render();
    act({ action: 'bmic', roomIds: ids });
  }

  // ---------- chat (painel flutuante) ----------
  var dockEl = null;
  var pillEl = null;
  function renderPill() {
    ensureDock();
    var total = 0;
    Object.keys(ui.unread).forEach(function (id) { total += ui.unread[id] || 0; });
    var show = !!S && S.phase !== 'done' && !ui.chatRoom && total > 0;
    pillEl.hidden = !show;
    if (show) pillEl.textContent = 'Chat · ' + total + (total === 1 ? ' mensagem nova' : ' mensagens novas');
  }
  function ensureDock() {
    if (dockEl) return;
    dockEl = document.createElement('div');
    dockEl.className = 'dock';
    dockEl.hidden = true;
    dockEl.innerHTML = '<div class="dock-head"><b id="dock-title">Chat</b><button class="btn btn-sm" data-act="chat-close" type="button">Esconder chat</button></div>' +
      '<div class="chat-list" id="dock-list" role="log" aria-live="polite"></div>' +
      '<form class="chat-form" id="dock-form" autocomplete="off"><input class="input" id="dock-in" maxlength="300" placeholder="Mensagem do professor para esta sala…" aria-label="Mensagem para a sala"><button class="btn btn-primary" type="submit">Enviar</button></form>';
    document.body.appendChild(dockEl);
    pillEl = document.createElement('button');
    pillEl.type = 'button';
    pillEl.className = 'chatpill';
    pillEl.hidden = true;
    pillEl.addEventListener('click', function () {
      var best = null;
      Object.keys(ui.unread).forEach(function (id) { if (ui.unread[id] && (!best || ui.unread[id] > ui.unread[best])) best = id; });
      if (!best) return;
      ui.chatRoom = best; ui.unread[best] = 0; renderDock(true); render();
    });
    document.body.appendChild(pillEl);
    dockEl.querySelector('#dock-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var inp = $('dock-in');
      var text = inp.value.trim();
      if (!text || !ui.chatRoom) return;
      inp.value = '';
      act({ action: 'chat', roomIds: [ui.chatRoom], text: text, name: profName });
    });
  }
  function chatMsgHTML(m) {
    if (m.from === 'professor') return '<div class="cm prof"><span class="who">Professor' + (m.name && m.name !== 'Professor' ? ' · ' + esc(m.name) : '') + '</span>' + esc(m.text) + '</div>';
    return '<div class="cm"><span class="who">' + esc(m.name) + '</span>' + esc(m.text) + '</div>';
  }
  function renderDock(stick) {
    ensureDock();
    renderPill();
    if (!ui.chatRoom || !S || S.phase === 'done') { dockEl.hidden = true; return; }
    var r = ui.chatRoom === 'lobby' ? { no: 'de espera' } : S.rooms.find(function (x) { return x.id === ui.chatRoom; });
    if (!r || (ui.chatRoom !== 'lobby' && !isLive())) { dockEl.hidden = true; ui.chatRoom = null; return; }
    dockEl.hidden = false;
    $('dock-title').textContent = ui.chatRoom === 'lobby' ? 'Chat · Sala de espera' : 'Chat · Sala ' + r.no;
    var list = ui.chat[ui.chatRoom] || [];
    var el = $('dock-list');
    var near = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    el.innerHTML = list.length ? list.map(chatMsgHTML).join('') : '<p class="none">Nenhuma mensagem ainda.</p>';
    if (stick || near) el.scrollTop = el.scrollHeight;
  }
  function addChatMsg(roomId, m) {
    var list = ui.chat[roomId] || (ui.chat[roomId] = []);
    if (list.some(function (x) { return x.id === m.id; })) return;
    list.push(m);
    if (ui.chatRoom === roomId) renderDock(false);
    else if (m.from !== 'professor') { ui.unread[roomId] = (ui.unread[roomId] || 0) + 1; if (S) render(); renderPill(); }
  }
  function fetchChat() {
    if (!S) return;
    var round = S.round;
    T('GET', '/api/professor/classes/' + classId + '/chat').then(function (r) {
      if (S.round !== round) return;
      ui.fetched = round;
      Object.keys(r.rooms).forEach(function (id) {
        var cur = ui.chat[id] || [];
        var have = new Set(cur.map(function (x) { return x.id; }));
        r.rooms[id].forEach(function (m) { if (!have.has(m.id)) cur.push(m); });
        cur.sort(function (a, b) { return a.id - b.id; });
        ui.chat[id] = cur;
      });
      renderDock(true);
    }, function () { /* ignorar */ });
  }

  // ---------- mensagem final da aula ----------
  var emEl = null;
  function ensureEm() {
    if (!emEl) {
      emEl = document.createElement('details');
      emEl.className = 'em';
      emEl.innerHTML = '<summary>Mensagem exibida aos alunos ao encerrar a aula</summary><div class="em-body">' +
        '<label class="lbl-t" for="em-text">Mensagem</label><textarea class="input" id="em-text" maxlength="600" rows="3" placeholder="Obrigado por participar! Até a próxima."></textarea>' +
        '<label class="lbl-t" for="em-url">Link (opcional)</label><input class="input" id="em-url" maxlength="500" inputmode="url" placeholder="https://seusite.com.br/pagina">' +
        '<label class="lbl-t" for="em-label">Texto do botão do link</label><input class="input" id="em-label" maxlength="40" placeholder="Abrir link">' +
        '<div class="em-actions"><button class="btn btn-primary" data-act="em-save" type="button">Salvar mensagem</button><button class="btn" data-act="em-reset" type="button">Voltar ao padrão</button><span class="small" id="em-status" role="status"></span></div></div>';
    }
    if (S && !ui.emInit) {
      ui.emInit = true;
      var em = S.endMessage || {};
      emEl.querySelector('#em-text').value = em.text || '';
      emEl.querySelector('#em-url').value = em.url || '';
      emEl.querySelector('#em-label').value = em.label || '';
    }
  }
  function saveEm(reset) {
    if (reset) { emEl.querySelector('#em-text').value = ''; emEl.querySelector('#em-url').value = ''; emEl.querySelector('#em-label').value = ''; }
    var st = emEl.querySelector('#em-status');
    st.textContent = 'Salvando…';
    T('POST', '/api/professor/classes/' + classId + '/act', { action: 'end-message', text: emEl.querySelector('#em-text').value, url: emEl.querySelector('#em-url').value, label: emEl.querySelector('#em-label').value }).then(function () {
      st.textContent = reset ? 'Voltou ao padrão.' : 'Salvo.';
      setTimeout(function () { if (st.textContent === 'Salvo.' || st.textContent === 'Voltou ao padrão.') st.textContent = ''; }, 2500);
    }, function (e) { st.textContent = e.message; });
  }

  function tick() {
    if (!S) return;
    var t = $('p-timer');
    var bar = $('p-bar');
    var counting = isLive() || S.phase === 'closing';
    if (S.endsAt && counting) {
      var left = (S.endsAt - (Date.now() + offset)) / 1000;
      var total = (isLive() ? S.roundMinutes : (S.closingMinutes || 5)) * 60;
      if (t) {
        t.textContent = A.mmss(left);
        t.className = 'timer' + (left <= 60 ? ' warn' : '');
      }
      if (bar) bar.style.width = Math.min(100, Math.max(0, 100 * (1 - left / total))) + '%';
      A.urgent(A.urgentText(left, isLive() ? 'para o fim da rodada' : 'para a aula encerrar'));
    } else {
      A.urgent(null);
      if (t) {
        t.className = 'timer idle';
        if (bar) bar.style.width = S.phase === 'done' ? '100%' : '0';
      }
    }
    document.querySelectorAll('[data-since]').forEach(function (el) {
      var sec = Math.max(0, Math.floor((Date.now() + offset - Number(el.getAttribute('data-since'))) / 1000));
      el.textContent = 'há ' + Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
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
    if (a === 'main') { ui.confirm = isPlanning() ? 'start' : (S.phase === 'closing' ? 'end-class' : 'end-round'); render(); return; }
    if (a === 'allow-late') { act({ action: 'allow-late', on: !S.allowLate }); return; }
    if (a === 'ask-end-class') { ui.confirm = 'end-class'; render(); return; }
    if (a === 'confirm-no') { ui.confirm = null; ui.kickPid = null; render(); return; }
    if (a === 'confirm-yes') {
      var what = ui.confirm;
      ui.confirm = null;
      render();
      if (what === 'kick') { var kp = ui.kickPid; ui.kickPid = null; act({ action: 'kick', pid: kp }); return; }
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
    if (a === 'mute') { act({ action: 'mute', pid: el.getAttribute('data-pid') }); return; }
    if (a === 'mute-room') {
      var mr = S.rooms.find(function (x) { return x.id === el.getAttribute('data-room'); });
      if (mr) act({ action: 'mute', pids: mr.members });
      return;
    }
    if (a === 'ask-kick') { ui.kickPid = el.getAttribute('data-pid'); ui.confirm = 'kick'; render(); return; }
    if (a === 'sel-all') { S.rooms.forEach(function (r) { ui.sel.add(r.id); }); render(); return; }
    if (a === 'sel-none') { ui.sel.clear(); render(); return; }
    if (a === 'bmic-all') { setBmic(S.rooms.map(function (r) { return r.id; })); return; }
    if (a === 'bmic-sel') { setBmic(selectedIds()); return; }
    if (a === 'bmic-off') { setBmic([]); return; }
    if (a === 'share-all') { startShare(S.rooms.map(function (r) { return r.id; })); return; }
    if (a === 'share-sel') { startShare(selectedIds()); return; }
    if (a === 'share-stop') { stopShare(); return; }
    if (a === 'bc-send-all') { sendBroadcast('all'); return; }
    if (a === 'chat-open') { ui.chatRoom = room; ui.unread[room] = 0; ensureDock(); renderDock(true); render(); setTimeout(function () { var i = $('dock-in'); if (i) i.focus(); }, 30); return; }
    if (a === 'chat-close') { ui.chatRoom = null; renderDock(false); render(); return; }
    if (a === 'em-save') { saveEm(false); return; }
    if (a === 'em-reset') { saveEm(true); return; }
    if (a === 'lobby-join') { ui.lobbyOn = true; ui.lobbyListen = true; ui.lobbyWatch = true; startAudioAll(); syncViews(); applyHear(); render(); return; }
    if (a === 'lobby-leave') { ui.lobbyOn = false; ui.lobbyWatch = false; ui.lobbyTalk = false; ui.lobbyCam = false; syncViews(); applyHear(); render(); return; }
    if (a === 'lobby-watch') { ui.lobbyWatch = !ui.lobbyWatch; applyHear(); render(); return; }
    if (a === 'lobby-listen') { ui.lobbyListen = !ui.lobbyListen; startAudioAll(); applyHear(); render(); return; }
    if (a === 'lobby-talk') { ui.lobbyTalk = !ui.lobbyTalk; startAudioAll(); applyHear(); render(); return; }
    if (a === 'lobby-cam') { ui.lobbyCam = !ui.lobbyCam; applyHear(); render(); return; }
    if (a === 'cam-all') { S.rooms.forEach(function (r) { ui.camRooms.add(r.id); }); syncViews(); applyHear(); render(); return; }
    if (a === 'cam-sel') { selectedIds().forEach(function (id) { ui.camRooms.add(id); }); syncViews(); applyHear(); render(); return; }
    if (a === 'cam-off') { ui.camRooms.clear(); applyHear(); syncViews(); render(); return; }
    if (a === 'room-join') {
      ui.joined.add(room); ui.watch.add(room);
      startAudioAll();
      setHear({ roomId: room, mode: 'listen' });      // entra ouvindo e vendo, com microfone e câmera desligados
      return;
    }
    if (a === 'room-leave') {
      ui.joined.delete(room); ui.watch.delete(room); ui.camRooms.delete(room);
      if (S.hear && S.hear.roomId === room) setHear(null);
      else { syncViews(); applyHear(); render(); }
      return;
    }
    if (a === 'watch') {
      if (ui.watch.has(room)) ui.watch.delete(room); else ui.watch.add(room);
      syncViews(); applyHear(); render();
      return;
    }
    if (a === 'cam') {
      if (ui.camRooms.has(room)) ui.camRooms.delete(room); else ui.camRooms.add(room);
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
      ui.joined.add(room); ui.watch.add(room);
      ui.camRooms.add(room);                   // ao atender, o professor também aparece na câmera da sala
      setHear({ roomId: room, mode: 'talk' });
      act({ action: 'answer', roomId: room });
    }
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el && el.matches && el.matches('select.mv')) doMove(el.getAttribute('data-pid'), el.value || null);
    else if (el && el.matches && el.matches('input[data-sel]')) {
      var id = el.getAttribute('data-sel');
      if (el.checked) ui.sel.add(id); else ui.sel.delete(id);
      document.querySelectorAll('input[data-sel="' + id + '"]').forEach(function (i) { i.checked = ui.sel.has(id); });
      renderBcTop();
    }
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
