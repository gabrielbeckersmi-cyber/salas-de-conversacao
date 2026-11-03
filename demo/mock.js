/* Roda DENTRO de cada tela (iframe), antes do código real do aluno. Troca servidor, WebSocket e vídeo por versões simuladas. */
(function () {
  var SLOT = window.__SLOT;
  function SIM() { return window.parent.SIM; }
  function Mem(init) {
    var d = {}; for (var k in init) d[k] = init[k];
    return { getItem: function (k) { return k in d ? d[k] : null; }, setItem: function (k, v) { d[k] = String(v); }, removeItem: function (k) { delete d[k]; }, clear: function () { d = {}; } };
  }
  Object.defineProperty(window, 'localStorage', { value: Mem({ 'salas:last': 'DEMO' }), configurable: true });
  Object.defineProperty(window, 'sessionStorage', { value: Mem({ 'salas:last': 'DEMO' }), configurable: true });
  window.__photo = function (pid) { return SIM().photo(pid); };

  // ---------- servidor de mentira ----------
  var realFetch = window.fetch.bind(window);
  function reply(status, json) { return Promise.resolve(new Response(JSON.stringify(json), { status: status, headers: { 'content-type': 'application/json' } })); }
  window.fetch = function (url, opt) {
    url = String(url);
    if (url.indexOf('/api/temas') === 0) return reply(200, SIM().temas());
    var m = url.match(/^\/api\/classes\/DEMO(\/[^?]*)?(\?.*)?$/);
    if (m) {
      var q = {};
      (m[2] || '').replace(/^\?/, '').split('&').forEach(function (p) { if (p) { var kv = p.split('='); q[kv[0]] = decodeURIComponent(kv[1] || ''); } });
      var body = null; try { body = opt && opt.body ? JSON.parse(opt.body) : null; } catch (e) { body = null; }
      var r = SIM().http(SLOT, (opt && opt.method) || 'GET', m[1] || '', body, q);
      return reply(r.status, r.json);
    }
    if (/^\/api\//.test(url)) return reply(200, {});
    if (/translate|mymemory/.test(url)) {
      // o tradutor usa a internet de verdade (igual à ferramenta real); se estiver sem internet, responde com frases de exemplo para a demonstração não travar
      return realFetch(url, opt).then(function (r) { if (!r.ok) throw new Error('http'); return r; }).catch(function () {
        var q = decodeURIComponent((url.match(/[?&]q=([^&]*)/) || [])[1] || '').trim();
        var low = q.toLowerCase().replace(/[.!?]+$/, '');
        var D = { 'olá': 'Hello', 'bom dia': 'Good morning', 'boa noite': 'Good night', 'como vai você': 'How are you', 'eu gosto de viajar': 'I like to travel', 'quero viajar para o brasil': 'I want to travel to Brazil',
          'hello': 'Olá', 'good morning': 'Bom dia', 'how are you': 'Como vai você', 'i like to travel': 'Eu gosto de viajar', 'nice to meet you': 'Prazer em conhecer você', 'thank you': 'Obrigado' };
        var out = D[low] || q;
        var isMy = /mymemory/.test(url);
        return reply(200, isMy ? { responseData: { translatedText: out } } : [[[out, q, null, null, 10]], null, 'auto']);
      });
    }
    return realFetch(url, opt);
  };
  var origBeacon = navigator.sendBeacon;
  navigator.sendBeacon = function (url, blob) { return false; };

  // ---------- WebSocket de mentira ----------
  function FakeWS(url) {
    var self = this;
    this.readyState = 0;
    var sid = (String(url).match(/student=([^&]+)/) || [])[1] || '';
    setTimeout(function () {
      if (self.readyState === 3) return;
      if (SIM().wsOpen(SLOT, decodeURIComponent(sid), self)) { self.readyState = 1; if (self.onopen) self.onopen({}); }
      else { self.readyState = 3; if (self.onclose) self.onclose({ code: 4003 }); }
    }, 60);
  }
  FakeWS.prototype.send = function () {};
  FakeWS.prototype.close = function (code) {
    if (this.readyState === 3) return;
    this.readyState = 3; SIM().wsClosed(SLOT, this);
    if (this.onclose) this.onclose({ code: code || 1000 });
  };
  FakeWS.prototype._msg = function (o) { if (this.onmessage) this.onmessage({ data: JSON.stringify(o) }); };
  window.WebSocket = FakeWS;

  // ---------- câmera e microfone: usa os reais; se não houver, usa imagem e som de mentira ----------
  var realGUM = navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices) : null;
  function fakeStream(c) {
    var ac = new (window.AudioContext || window.webkitAudioContext)();
    var d = ac.createMediaStreamDestination(); var o = ac.createOscillator(); o.frequency.value = 180;
    var g = ac.createGain(); g.gain.value = 0.4; o.connect(g); g.connect(d); o.start();
    var lfo = ac.createOscillator(); lfo.frequency.value = 3; var lg = ac.createGain(); lg.gain.value = 0.3; lfo.connect(lg); lg.connect(g.gain); lfo.start();
    var st = d.stream;
    if (c && c.video) {
      var cv = document.createElement('canvas'); cv.width = 640; cv.height = 480; var x = cv.getContext('2d'), t = 0;
      setInterval(function () { t += 0.1; x.fillStyle = '#3b6'; x.fillRect(0, 0, 640, 480); x.fillStyle = '#fff'; x.beginPath(); x.arc(320 + Math.sin(t) * 20, 200, 70, 0, 7); x.fill(); x.fillRect(220, 290, 200, 190); }, 80);
      cv.captureStream(12).getVideoTracks().forEach(function (v) { st.addTrack(v); });
    }
    return st;
  }
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = function (c) {
      if (SIM().useFake() || !realGUM) return Promise.resolve(fakeStream(c));
      return realGUM(c).catch(function (e) { if (e && e.name === 'OverconstrainedError') throw e; return Promise.resolve(fakeStream(c)); });
    };
  }

  // ---------- vídeo da sala (LiveKit de mentira) ----------
  var PAL = ['#7c5cd6', '#2f8f6f', '#d9822b', '#2b7bd9', '#c4457a', '#4d9aa8', '#8a6d3b', '#6b7bd6'];
  var pool = [];
  function makePool() {
    PAL.forEach(function (col, i) {
      var cv = document.createElement('canvas'); cv.width = 320; cv.height = 240; var x = cv.getContext('2d'); var t = i * 2;
      function draw() {
        t += 0.06;
        var g = x.createLinearGradient(0, 0, 320, 240); g.addColorStop(0, col); g.addColorStop(1, '#223'); x.fillStyle = g; x.fillRect(0, 0, 320, 240);
        x.fillStyle = 'rgba(255,255,255,.12)'; x.beginPath(); x.arc(60 + Math.sin(t * .5) * 20, 50, 50, 0, 7); x.fill();
        var sx = Math.sin(t) * 10, sy = Math.sin(t * 1.7) * 3;
        x.fillStyle = '#f1c9a5'; x.beginPath(); x.arc(160 + sx, 105 + sy, 38, 0, 7); x.fill();
        x.fillStyle = '#2b2b3a'; x.beginPath(); x.arc(160 + sx, 92 + sy, 38, 3.3, 6.1); x.fill();
        x.fillStyle = '#fff'; x.beginPath(); x.ellipse(160 + sx * .6, 250, 86, 82, 0, 0, 7); x.fill();
        x.fillStyle = col; x.beginPath(); x.ellipse(160 + sx * .6, 255, 70, 66, 0, 0, 7); x.fill();
      }
      if (i % 3 === 2) {   // algumas câmeras "de celular em pé": vídeo vertical
        var pc = document.createElement('canvas'); pc.width = 240; pc.height = 360; var px = pc.getContext('2d');
        var drawP = function () { draw(); px.fillStyle = col; px.fillRect(0, 0, 240, 360); px.drawImage(cv, 40, 0, 240, 240, 0, 60, 240, 240); };
        drawP(); setInterval(drawP, 120);
        pool.push(pc.captureStream(8));
        return;
      }
      draw(); setInterval(draw, 120);
      pool.push(cv.captureStream(8));
    });
  }
  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

  function Emitter() { this.h = {}; }
  Emitter.prototype.on = function (e, f) { (this.h[e] = this.h[e] || []).push(f); return this; };
  Emitter.prototype.off = function (e, f) { this.h[e] = (this.h[e] || []).filter(function (x) { return x !== f; }); return this; };
  Emitter.prototype.emit = function (e) { var a = Array.prototype.slice.call(arguments, 1); (this.h[e] || []).slice().forEach(function (f) { try { f.apply(null, a); } catch (er) { console.error(er); } }); };

  function mkTrack(kind, stream) {
    return {
      kind: kind, els: [],
      attach: function (el) {
        if (kind === 'audio') { return document.createElement('audio'); }
        el = el || document.createElement('video'); el.srcObject = stream; el.muted = true; el.playsInline = true;
        var p = el.play && el.play(); if (p && p.catch) p.catch(function () {}); if (this.els.indexOf(el) < 0) this.els.push(el); return el;
      },
      detach: function () { var e = this.els.slice(); this.els = []; return e; }
    };
  }
  function Remote(info) {
    this.identity = info.identity; this.name = info.name; this.trackPublications = new Map(); this.info = info;
  }

  // abre a câmera/microfone ESCOLHIDOS pelo aluno no teste (deviceId); se o aparelho escolhido falhar, tenta o padrão
  function openMedia(kind, defaults, forceId) {
    var id = forceId || (defaults && defaults.deviceId);
    function want(withId) {
      var c = {};
      if (kind === 'video') { c.video = { width: { ideal: 640 }, height: { ideal: 480 } }; if (withId && id) c.video.deviceId = { exact: id }; }
      else { c.audio = {}; if (withId && id) c.audio.deviceId = { exact: id }; }
      return navigator.mediaDevices.getUserMedia(c);
    }
    return id ? want(true).catch(function () { return want(false); }) : want(false);
  }
  function Local(room) {
    this.room = room; this.identity = ''; this.isMicrophoneEnabled = false; this.isCameraEnabled = false;
    this.micStream = null; this.camTrack = null;
  }
  function LocalCam(local) {
    var self = this; this.kind = 'video'; this.els = []; this.proc = null; this.raw = null; this.out = null; this.local = local;
    this.mediaStreamTrack = null;
  }
  LocalCam.prototype.attach = function (el) {
    el = el || document.createElement('video'); el.muted = true; el.playsInline = true;
    el.srcObject = this.out || this.raw; var p = el.play && el.play(); if (p && p.catch) p.catch(function () {});
    if (this.els.indexOf(el) < 0) this.els.push(el); return el;
  };
  LocalCam.prototype.detach = function () { var e = this.els.slice(); this.els = []; return e; };
  LocalCam.prototype.getProcessor = function () { return this.proc; };
  LocalCam.prototype.stopProcessor = function () { this.proc = null; this.out = null; if (this.loop) clearInterval(this.loop); this._swap(); return Promise.resolve(); };
  LocalCam.prototype.setProcessor = function (p) {
    var self = this; self.proc = p;
    // desfoque de mentira: fundo borrado e uma elipse nítida no centro
    var v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = self.raw; v.play().catch(function () {});
    var cv = document.createElement('canvas'); cv.width = 640; cv.height = 480; var x = cv.getContext('2d');
    self.loop = setInterval(function () {
      if (!v.videoWidth) return; cv.width = v.videoWidth; cv.height = v.videoHeight; var w = cv.width, h = cv.height;
      x.save(); x.filter = 'blur(9px)'; x.drawImage(v, -20, -20, w + 40, h + 40); x.restore();
      x.save(); x.beginPath(); x.ellipse(w / 2, h * 0.52, w * 0.27, h * 0.5, 0, 0, 7); x.clip(); x.drawImage(v, 0, 0, w, h); x.restore();
    }, 66);
    self.out = cv.captureStream(15);
    return new Promise(function (r) { setTimeout(function () { self._swap(); r(); }, 400); });
  };
  LocalCam.prototype.replace = function (st) {
    var old = this.raw, had = this.proc;
    this.raw = st;
    if (old) old.getTracks().forEach(function (t) { t.stop(); });
    if (had) { if (this.loop) clearInterval(this.loop); this.out = null; return this.setProcessor(had); }
    this.out = null; this._swap(); return Promise.resolve();
  };
  LocalCam.prototype._swap = function () { var s = this.out || this.raw; this.els.forEach(function (e) { e.srcObject = s; var p = e.play(); if (p && p.catch) p.catch(function () {}); }); };

  Local.prototype.setCameraEnabled = function (on) {
    var self = this;
    if (!on) {
      if (self.camTrack && self.camTrack.raw) self.camTrack.raw.getTracks().forEach(function (t) { t.stop(); });
      self.isCameraEnabled = false; self.camTrack = null;
      self.room.emit('LocalTrackUnpublished'); return Promise.resolve();
    }
    return openMedia('video', self.room.opts.videoCaptureDefaults).then(function (st) {
      var t = new LocalCam(self); t.raw = st; self.camTrack = t; self.isCameraEnabled = true;
      self.room.emit('LocalTrackPublished'); return;
    });
  };
  Local.prototype.setMicrophoneEnabled = function (on) {
    var self = this;
    if (!on) { if (self.micStream) self.micStream.getTracks().forEach(function (t) { t.stop(); }); self.micStream = null; self.isMicrophoneEnabled = false; self.room.emit('LocalTrackUnpublished'); return Promise.resolve(); }
    return openMedia('audio', self.room.opts.audioCaptureDefaults).then(function (st) { self.micStream = st; self.isMicrophoneEnabled = true; self.room.emit('LocalTrackPublished'); });
  };
  Local.prototype.getTrackPublication = function (src) {
    if (src === 'camera') return this.camTrack ? { track: this.camTrack, isMuted: false, kind: 'video' } : null;
    if (src === 'microphone') return this.isMicrophoneEnabled ? { track: {}, isMuted: false, kind: 'audio' } : null;
    return null;
  };
  Local.prototype.publishTrack = function () { return Promise.resolve(); };
  Local.prototype.unpublishTrack = function () { return Promise.resolve(); };

  function Room(opts) {
    Emitter.call(this);
    this.remoteParticipants = new Map(); this.localParticipant = new Local(this);
    this.opts = opts || {}; this.state = 'disconnected'; this.canPlaybackAudio = true; this.name = '';
    (window.__rooms = window.__rooms || []).push(this);
  }
  Room.prototype = Object.create(Emitter.prototype);
  Room.prototype.connect = function (url, token) {
    var self = this; self.name = token; self.state = 'connected';
    return new Promise(function (res) { setTimeout(function () { self.sync(); res(); }, 350); });
  };
  Room.prototype.disconnect = function () { this.state = 'disconnected'; this.remoteParticipants.clear(); };
  Room.prototype.startAudio = function () { return Promise.resolve(); };
  Room.prototype.getActiveDevice = function () { return null; };
  Room.prototype.switchActiveDevice = function (kind, id) {
    var self = this, lp = this.localParticipant;
    if (kind === 'videoinput') {
      self.opts.videoCaptureDefaults = Object.assign({}, self.opts.videoCaptureDefaults, { deviceId: id });
      var t = lp.camTrack; if (!t) return Promise.resolve();
      return openMedia('video', self.opts.videoCaptureDefaults, id).then(function (st) { t.replace(st); });
    }
    self.opts.audioCaptureDefaults = Object.assign({}, self.opts.audioCaptureDefaults, { deviceId: id });
    if (!lp.micStream) return Promise.resolve();
    return openMedia('audio', self.opts.audioCaptureDefaults, id).then(function (st) { lp.micStream.getTracks().forEach(function (x) { x.stop(); }); lp.micStream = st; });
  };
  Room.prototype.sync = function () {
    var self = this; if (self.state !== 'connected') return;
    if (!pool.length) makePool();
    var list = SIM().roster(SLOT, self.name) || [];
    var ids = {}; list.forEach(function (i) { ids[i.identity] = i; });
    Array.from(self.remoteParticipants.keys()).forEach(function (id) {
      if (!ids[id]) { var p = self.remoteParticipants.get(id); self.remoteParticipants.delete(id); self.emit('ParticipantDisconnected', p); }
    });
    list.forEach(function (i) {
      var p = self.remoteParticipants.get(i.identity);
      if (!p) {
        p = new Remote(i); self.remoteParticipants.set(i.identity, p);
        self.emit('ParticipantConnected', p);
        var vt = mkTrack('video', pool[hash(i.identity) % pool.length]), at = mkTrack('audio');
        var vp = { kind: 'video', isMuted: !i.cam, track: vt, source: 'camera' }, ap = { kind: 'audio', isMuted: !i.mic, track: at, source: 'microphone' };
        p.trackPublications.set('v', vp); p.trackPublications.set('a', ap);
        setTimeout(function () { if (self.remoteParticipants.get(i.identity) === p) { self.emit('TrackSubscribed', vt, vp, p); self.emit('TrackSubscribed', at, ap, p); } }, 120);
      }
    });
  };
  window.__simSync = function () { (window.__rooms || []).forEach(function (r) { if (r.state === 'connected') r.sync(); }); };
  // quem está falando (realça o quadrinho)
  setInterval(function () {
    (window.__rooms || []).forEach(function (r) {
      if (r.state !== 'connected') return;
      var c = Array.from(r.remoteParticipants.values()).filter(function (p) { return p.info.mic; });
      if (!c.length || Math.random() < 0.25) { r.emit('ActiveSpeakersChanged', []); return; }
      r.emit('ActiveSpeakersChanged', [c[Math.floor(Math.random() * c.length)]]);
    });
  }, 1700);

  window.LKBlur = { supported: function () { return true; }, BackgroundProcessor: function (o) { return { name: 'blur' }; } };
  window.LivekitClient = {
    Room: Room,
    RoomEvent: new Proxy({}, { get: function (_, k) { return String(k); } }),
    DisconnectReason: {},
    Track: { Source: { Camera: 'camera', Microphone: 'microphone', ScreenShare: 'screen_share' } },
    LocalVideoTrack: function (t) { this.mediaStreamTrack = t; }
  };
})();
