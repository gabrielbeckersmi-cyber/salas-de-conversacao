/* Controlador do simulador (página principal). Usa a MESMA lógica de aula do servidor (lib/classes.js e lib/dinamicas.js). */
(function () {
  var C = SIMLIB.C, D = SIMLIB.D;
  var NAMES = [['Ana Clara', 'basico'], ['Bruno', 'intermediario'], ['Carla M.', 'basico'], ['Diego', 'intermediario'], ['Elisa', 'basico'], ['Fábio R.', 'intermediario'], ['Gabi', 'basico'], ['Heitor', 'intermediario'],
    ['Isabela', 'basico'], ['João P.', 'intermediario'], ['Karen', 'basico'], ['Lucas', 'intermediario'], ['Marina', 'basico'], ['Nicolas', 'intermediario'], ['Olívia', 'basico'], ['Pedro H.', 'intermediario'],
    ['Quésia', 'basico'], ['Rafael', 'intermediario'], ['Sofia', 'basico'], ['Thiago', 'intermediario'], ['Valentina', 'basico'], ['Wesley', 'intermediario'], ['Yasmin', 'basico'], ['Zeca', 'intermediario']];
  var LINES = ['Hi everyone! 👋', 'Hello! How are you?', 'I am fine, thanks!', 'Nice to meet you', 'What did you do today?', 'I like travelling', 'Can you repeat, please?', 'My favorite food is pizza 🍕', 'Good evening!', 'I am a little nervous', 'Let us start!', 'I think so too'];
  var TEMAS = { t1: 'Travel', t2: 'Food' };
  var store, c, photos, slots, fakeSeq, timer, pushT, useFake = false;
  var endMsg = { text: 'Obrigado por participar! Até a próxima aula.', url: 'https://www.google.com', label: 'Abrir link' };

  function lkName(room) { return 'DEMO-r' + c.round + '-' + room; }
  function lobbyName() { return 'DEMO-lobby'; }

  function reset() {
    store = {};
    c = C.createClass(store, { title: 'Aula de conversação · demonstração', roundMinutes: Number(document.getElementById('p-min') ? document.getElementById('p-min').value : 2) || 2 });
    delete store[c.id]; c.id = 'DEMO'; store.DEMO = c;
    C.setEndMessage(c, endMsg);
    photos = {}; fakeSeq = 0;
    slots = slots || { mobile: { ws: new Set(), win: null }, desktop: { ws: new Set(), win: null } };
    ['mobile', 'desktop'].forEach(function (k) { slots[k].ws.forEach(function (w) { try { w.readyState = 3; } catch (e) { /* ignorar */ } }); slots[k].ws = new Set(); });
    for (var i = 0; i < 12; i++) addFake(true);
  }
  function addFake(quiet) {
    var n = NAMES[fakeSeq % NAMES.length]; fakeSeq++;
    var nm = n[0] + (fakeSeq > NAMES.length ? ' ' + Math.ceil(fakeSeq / NAMES.length) : '');
    try {
      var s = C.joinStudent(c, { name: nm, level: n[1] });
      s.fake = true; s.cam = Math.random() < 0.8; s.mic = Math.random() < 0.6;
      C.setOnline(c, s.id, true);
      if (C.isLive(c) && !C.roomOf(c, s.pid)) C.placeStudentLive(c, s);
    } catch (e) { /* lotada ou aula encerrada */ }
    if (!quiet) schedule();
  }

  // ---------- envio de estado ----------
  function snapshotFor(s) {
    var v = C.studentView(c, s);
    if (v.room && C.isLive(c)) v.room.lk = { url: 'sim', room: lkName(v.room.id), token: lkName(v.room.id) };
    else if (c.phase !== 'done') v.lobby = { url: 'sim', room: lobbyName(), token: lobbyName() };
    return v;
  }
  function schedule() { clearTimeout(pushT); pushT = setTimeout(pushAll, 40); }
  function pushAll() {
    Object.keys(slots).forEach(function (k) {
      slots[k].ws.forEach(function (ws) {
        var s = c.students[ws.sid];
        if (!s) { ws._msg({ type: 'removed' }); return; }
        ws._msg({ type: 'state', data: snapshotFor(s) });
      });
      var w = slots[k].win; if (w && w.__simSync) setTimeout(function () { try { w.__simSync(); } catch (e) { /* ignorar */ } }, 80);
    });
    renderPanel();
  }
  function wsOf(s) { var out = []; Object.keys(slots).forEach(function (k) { slots[k].ws.forEach(function (w) { if (w.sid === s.id) out.push(w); }); }); return out; }
  function sendChat(roomId, msg) {
    var inRoom = function (st) {
      if (roomId === 'lobby') return !(C.isLive(c) && C.roomOf(c, st.pid));
      var r = c.rooms.find(function (x) { return x.id === roomId; });
      return !!r && r.members.indexOf(st.pid) !== -1;
    };
    C.studentList(c).forEach(function (st) { if (inRoom(st)) wsOf(st).forEach(function (w) { w._msg({ type: 'chat', roomId: roomId, msg: msg }); }); });
  }
  function dynCopy(room) { return Object.assign({}, room, { members: room.members.filter(function (p) { var x = C.byPid(c, p); return x && !x.listener; }) }); }
  function pushDyn(room0) {
    var room = dynCopy(room0), now = Date.now();
    room.members.forEach(function (pid) { var st = C.byPid(c, pid); if (st) wsOf(st).forEach(function (w) { w._msg({ type: 'dyn', roomId: room.id, data: D.view(c, room, pid, now) }); }); });
  }

  // ---------- "servidor" que as telas chamam ----------
  function err(e) { if (e instanceof C.AppError) return { status: e.status, json: { error: e.code, message: e.message } }; console.error(e); return { status: 500, json: { error: 'server', message: 'Erro na simulação.' } }; }
  function http(slot, method, path, b, q) {
    b = b || {}; q = q || {};
    try {
      var s = c.students[String(b.studentId || q.studentId || '')];
      var need = function () { if (!s) throw new C.AppError(404, 'student', 'Aluno não encontrado.'); return s; };
      if (path === '/public') return { status: 200, json: { title: c.title, phase: c.phase, allowLate: !!c.allowLate, endMessage: c.phase === 'done' ? (c.endMessage || null) : null } };
      if (path === '/join') {
        var st = C.joinStudent(c, { name: b.name, level: b.level, resumeId: b.resumeId });
        st.slot = slot; schedule();
        return { status: 200, json: { studentId: st.id, pid: st.pid, name: st.name, level: st.level, listener: !!st.listener } };
      }
      if (path === '/foto') { photos[need().pid] = String(b.photo || ''); s.hasPhoto = true; schedule(); return { status: 200, json: { ok: true } }; }
      if (path === '/chat' && method === 'POST') { var r = C.studentSay(c, need(), b.text, b.speak === true); sendChat(r.roomId, r.msg); return { status: 200, json: { ok: true } }; }
      if (path === '/chat') {
        need(); var room = C.isLive(c) ? C.roomOf(c, s.pid) : null;
        return { status: 200, json: { roomId: room ? room.id : null, messages: room ? C.chatHistory(c, room.id) : [], lobby: C.chatHistory(c, 'lobby') } };
      }
      if (path === '/dyn') {
        need(); if (s.listener) throw new C.AppError(403, 'listener', 'Como ouvinte você não consegue interagir.');
        var rm = C.isLive(c) ? C.roomOf(c, s.pid) : null;
        if (method === 'POST') {
          if (!rm) throw new C.AppError(409, 'no-room', 'Você ainda não está em uma sala.');
          D.act(c, dynCopy(rm), String(b.action || ''), Date.now(), undefined); pushDyn(rm); return { status: 200, json: { ok: true } };
        }
        return { status: 200, json: { roomId: rm ? rm.id : null, data: rm ? D.view(c, dynCopy(rm), s.pid, Date.now()) : null } };
      }
      if (path === '/score') { var best = C.submitScore(c, need(), b.score); schedule(); return { status: 200, json: { best: best } }; }
      if (path === '/call') { C.setCall(c, need(), !!b.on); schedule(); return { status: 200, json: { ok: true } }; }
      if (path === '/leave') {
        if (s) { wsOf(s).forEach(function (w) { w.close(4005); }); C.setOnline(c, s.id, false); schedule(); }
        return { status: 200, json: { ok: true } };
      }
      return { status: 200, json: { ok: true } };   // problem etc.
    } catch (e) { return err(e); }
  }
  function wsOpen(slot, sid, ws) {
    var s = c.students[sid]; if (!s) return false;
    ws.sid = sid; slots[slot].ws.add(ws);
    C.setOnline(c, sid, true); s.slot = slot;
    if (C.isLive(c) && !C.roomOf(c, s.pid)) C.placeStudentLive(c, s);
    setTimeout(function () { ws._msg({ type: 'state', data: snapshotFor(s) }); renderPanel(); }, 30);
    schedule();
    return true;
  }
  function wsClosed(slot, ws) { slots[slot].ws.delete(ws); }
  function roster(slot, name) {
    var me = null; slots[slot].ws.forEach(function (w) { me = c.students[w.sid] || me; });
    var members;
    if (name === lobbyName()) members = C.studentList(c).filter(function (s) { return !(C.isLive(c) && C.roomOf(c, s.pid)); });
    else {
      var m = name.match(/^DEMO-r\d+-(.+)$/); var room = m && c.rooms.find(function (r) { return r.id === m[1]; });
      members = room ? room.members.map(function (p) { return C.byPid(c, p); }).filter(Boolean) : [];
    }
    return members.filter(function (s) { return s.online && !s.listener && (!me || s.pid !== me.pid); })
      .map(function (s) { return { identity: s.pid, name: s.name, cam: s.fake ? s.cam : true, mic: s.fake ? s.mic : true }; });
  }

  // ---------- relógio ----------
  setInterval(function () {
    if (!c) return;
    if ((C.isLive(c) || c.phase === 'closing') && c.endsAt && c.endsAt <= Date.now()) { C.timeUp(c); schedule(); }
    else renderTimer();
  }, 500);

  // ---------- painel do professor (simulado) ----------
  function $(id) { return document.getElementById(id); }
  function mmss(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
  var PH = { lobby: 'Sala de espera (aula ainda não começou)', r1: 'Rodada 1 ao vivo', between: 'Intervalo entre as rodadas', r2: 'Rodada 2 ao vivo', closing: 'Encerramento (todos na sala de espera)', done: 'Aula encerrada' };
  function renderTimer() { var t = $('p-timer'); if (t) t.textContent = c.endsAt && (C.isLive(c) || c.phase === 'closing') ? mmss(c.endsAt - Date.now()) : '--:--'; }
  function renderPanel() {
    if (!$('p-phase')) return;
    $('p-phase').textContent = PH[c.phase];
    renderTimer();
    var list = C.studentList(c), online = list.filter(function (s) { return s.online; });
    $('p-count').textContent = online.length + ' aluno' + (online.length === 1 ? '' : 's') + ' online';
    var h = '';
    if (C.isLive(c)) {
      c.rooms.forEach(function (r) {
        var names = r.members.map(function (p) { var s = C.byPid(c, p); return s ? (s.fake ? s.name : '<b>' + s.name + '</b>') + (s.callAt ? ' 🙋' : '') : ''; }).join(', ');
        h += '<div class="rm"><span>Sala ' + r.no + '</span>' + names + '</div>';
      });
    } else {
      h = '<div class="rm"><span>Espera</span>' + online.map(function (s) { return s.fake ? s.name : '<b>' + s.name + '</b>'; }).join(', ') + '</div>';
    }
    $('p-rooms').innerHTML = h;
    var live = C.isLive(c), plan = c.phase === 'lobby' || c.phase === 'between', done = c.phase === 'done';
    $('b-start').hidden = !plan; $('b-start').textContent = c.phase === 'lobby' ? '▶ Iniciar a aula (montar salas e começar a rodada 1)' : '▶ Iniciar a rodada 2';
    $('b-skip').hidden = !(live || c.phase === 'closing'); $('b-skip').textContent = live ? '⏩ Pular para o fim da rodada (aviso de 5 s)' : '⏩ Pular o encerramento';
    $('b-end').hidden = done; $('b-add').hidden = done; $('b-chat').hidden = done; $('b-say').style.display = done ? 'none' : 'flex'; $('b-mute').hidden = done;
    $('b-answer').hidden = !(live && c.rooms.some(function (r) { return r.members.some(function (p) { var s = C.byPid(c, p); return s && s.callAt; }); }));
    $('b-late').hidden = done; $('b-late').textContent = c.allowLate ? '🔓 Entrada tardia liberada' : '🔒 Liberar entrada tardia';
  }
  function act(name) {
    try {
      if (name === 'start') { c.roundMinutes = Number($('p-min').value) || 2; C.startRound(c); }
      else if (name === 'skip') { c.endsAt = Date.now() + 5000; }
      else if (name === 'end') { C.endClass(c, 'professor'); }
      else if (name === 'add') { for (var i = 0; i < 4; i++) (function (k) { setTimeout(function () { addFake(); }, k * 500); })(i); }
      else if (name === 'late') { C.setAllowLate(c, !c.allowLate); }
      else if (name === 'chat') {
        var targets = [];
        Object.keys(slots).forEach(function (k) { slots[k].ws.forEach(function (w) { var s = c.students[w.sid]; if (s) targets.push(s); }); });
        targets.forEach(function (me) {
          var rm = C.isLive(c) ? C.roomOf(c, me.pid) : null;
          var pool = rm ? rm.members.map(function (p) { return C.byPid(c, p); }) : C.studentList(c);
          pool = pool.filter(function (s) { return s && s.fake && s.online && !s.listener; });
          [0, 1, 2].forEach(function (i) {
            setTimeout(function () {
              var f = pool[Math.floor(Math.random() * pool.length)]; if (!f) return;
              f.chatAt = 0;
              try { var r = C.studentSay(c, f, LINES[Math.floor(Math.random() * LINES.length)]); sendChat(r.roomId, r.msg); } catch (e) { /* ignorar */ }
            }, i * 900);
          });
        });
      }
      else if (name === 'say') {
        var txt = $('p-say').value.trim() || 'Olá, pessoal! Vamos começar.';
        C.teacherSay(c, 'all', txt, 'Professor').forEach(function (x) { sendChat(x.roomId, x.msg); });
        try { C.teacherSay(c, ['lobby'], txt, 'Professor').forEach(function (x) { sendChat(x.roomId, x.msg); }); } catch (e) { /* ignorar */ }
      }
      else if (name === 'mute') { Object.keys(slots).forEach(function (k) { slots[k].ws.forEach(function (w) { w._msg({ type: 'mute' }); }); }); }
      else if (name === 'answer') { c.rooms.forEach(function (r) { C.answerCall(c, r.id); }); }
      else if (name === 'reset') { reset(); document.dispatchEvent(new Event('sim-reset')); return; }
    } catch (e) { alert(e.message || 'Não foi possível.'); }
    schedule();
  }
  function saveEnd() {
    endMsg = { text: $('p-etext').value, url: $('p-eurl').value, label: $('p-elabel').value };
    try { C.setEndMessage(c, endMsg); } catch (e) { alert(e.message); }
    schedule();
  }

  window.SIM = {
    http: http, wsOpen: wsOpen, wsClosed: wsClosed, roster: roster,
    temas: function () { return TEMAS; },
    photo: function (pid) { return photos[pid] || ''; },
    useFake: function () { return useFake; },
    setFake: function (v) { useFake = !!v; },
    act: act, saveEnd: saveEnd, slots: function () { return slots; }, init: function () { reset(); renderPanel(); }, endMsg: function () { return endMsg; }
  };
})();
