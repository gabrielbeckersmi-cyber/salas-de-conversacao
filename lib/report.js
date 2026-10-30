'use strict';
// Monta o relatório de uma aula a partir do estado dela. Não conhece HTTP nem armazenamento.

const KIND_LABEL = {
  'aluno-caiu': 'Aluno perdeu a conexão com o servidor',
  'aluno-timeout': 'Aluno parou de responder (conexão travou)',
  'professor-caiu': 'Professor perdeu a conexão com o servidor',
  'video-falhou': 'Falha ao entrar na sala de vídeo',
  'video-caiu': 'Queda na sala de vídeo',
  'video-reconectando': 'Sala de vídeo reconectando',
  'qualidade-ruim': 'Qualidade de conexão ruim (travamentos)',
  'servidor-reiniciou': 'Servidor reiniciou durante a aula'
};

function buildReport(c, now) {
  const list = Object.keys(c.students || {}).map(function (k) { return c.students[k]; });
  const students = list.map(function (s) {
    return {
      name: s.name,
      level: s.level,
      listener: !!s.listener,
      joinedAt: s.joinedAt,
      late: !!s.late,
      rounds: (s.att || []).slice().sort(),
      best: s.best || 0,
      calls: s.callCount || 0
    };
  }).sort(function (a, b) { return a.name.localeCompare(b.name, 'pt-BR'); });
  const count = function (arr, lv) { return arr.filter(function (s) { return s.level === lv && !s.listener; }).length; };
  const attended = students.filter(function (s) { return s.rounds.length > 0; });
  const probs = (c.problems || []).slice();
  const byKind = {};
  probs.forEach(function (p) { byKind[p.kind] = (byKind[p.kind] || 0) + 1; });
  return {
    id: c.id,
    title: c.title,
    phase: c.phase,
    createdAt: c.createdAt,
    startedAt: c.startedAt || null,
    endedAt: c.endedAt || null,
    closedBy: c.closedBy || null,
    roundMinutes: c.roundMinutes,
    rounds: (c.rounds || []).map(function (r) { return { n: r.n, startedAt: r.startedAt, endedAt: r.endedAt || null }; }),
    totals: {
      joined: students.length,
      basico: count(students, 'basico'),
      intermediario: count(students, 'intermediario'),
      ouvintes: students.filter(function (s) { return s.listener; }).length,
      attended: attended.length,
      attendedBasico: count(attended, 'basico'),
      attendedIntermediario: count(attended, 'intermediario'),
      onlyWaiting: students.length - attended.length,
      late: students.filter(function (s) { return s.late; }).length
    },
    calls: {
      total: (c.calls || []).length,
      answered: (c.calls || []).filter(function (x) { return x.answeredAt; }).length,
      cancelled: (c.calls || []).filter(function (x) { return x.cancelledAt && !x.answeredAt; }).length
    },
    students: students,
    problems: {
      total: probs.length,
      byKind: byKind,
      labels: KIND_LABEL,
      list: probs.slice(-100).map(function (p) { return { at: p.at, kind: p.kind, who: p.who || '' }; })
    },
    updatedAt: now || Date.now()
  };
}

module.exports = { buildReport, KIND_LABEL };
