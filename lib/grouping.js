'use strict';
// Formação de salas por nível. Sem dependências: roda no Node (servidor e testes).

const GROUP_MAX = 4;

function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// Divide n alunos em exatamente k salas, tamanhos o mais parecidos possível.
function splitInto(n, k) {
  const base = Math.floor(n / k);
  const extra = n % k;
  const sizes = [];
  for (let i = 0; i < k; i++) sizes.push(base + (i < extra ? 1 : 0));
  return sizes;
}

// Número de salas que permite trocar todos os parceiros na rodada seguinte:
// a maior sala precisa ter no máximo tantos alunos quanto o número de salas.
// Ex.: 12 alunos em 3 salas de 4 não têm solução; em 4 salas de 3 têm.
// Prefere salas de 4; só usa salas menores quando isso é necessário.
function chooseK(n, max) {
  const kMin = Math.ceil(n / max);
  for (let k = kMin; k <= Math.floor(n / 2); k++) {
    if (splitInto(n, k)[0] <= k) return k;
  }
  return kMin;
}

function pairKey(a, b) {
  return a < b ? a + '|' + b : b + '|' + a;
}

function countRepeats(groups, met) {
  let c = 0;
  for (const g of groups) {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        if (met.has(pairKey(g[i], g[j]))) c++;
      }
    }
  }
  return c;
}

// Troca alunos entre salas enquanto isso reduzir pares repetidos.
function improve(groups, met) {
  let score = countRepeats(groups, met);
  let improved = true;
  while (improved && score > 0) {
    improved = false;
    for (let a = 0; a < groups.length && score > 0; a++) {
      for (let b = a + 1; b < groups.length && score > 0; b++) {
        for (let i = 0; i < groups[a].length && score > 0; i++) {
          for (let j = 0; j < groups[b].length && score > 0; j++) {
            const t = groups[a][i]; groups[a][i] = groups[b][j]; groups[b][j] = t;
            const s = countRepeats(groups, met);
            if (s < score) { score = s; improved = true; }
            else { const u = groups[a][i]; groups[a][i] = groups[b][j]; groups[b][j] = u; }
          }
        }
      }
    }
  }
  return score;
}

// opts.k força o número de salas do nível; sem isso usa chooseK.
function tryK(ids, met, k, rnd, attempts, max) {
  const n = ids.length;
  const sizes = splitInto(n, k);
  let best = null;
  let bestScore = Infinity;
  for (let t = 0; t < attempts && bestScore > 0; t++) {
    const s = shuffle(ids, rnd);
    const groups = [];
    let p = 0;
    for (const sz of sizes) { groups.push(s.slice(p, p + sz)); p += sz; }
    let sc = countRepeats(groups, met);
    if (sc > 0) sc = improve(groups, met);
    if (sc < bestScore) { best = groups; bestScore = sc; }
  }
  return { groups: best || [], repeats: bestScore === Infinity ? 0 : bestScore };
}

function formGroupsForLevel(ids, met, opts) {
  const o = opts || {};
  const max = o.max || GROUP_MAX;
  const rnd = o.rnd || Math.random;
  const attempts = o.attempts || 400;
  const n = ids.length;
  const k = Math.min(n, Math.max(1, o.k || chooseK(n, max)));
  let res = tryK(ids, met, k, rnd, attempts, max);
  // Se não for possível evitar repetições com esse número de salas e o professor
  // não fixou o número, tenta outros números de salas (3-4 por sala, ou 2 se preciso).
  if (res.repeats > 0 && !o.k) {
    const cands = [];
    for (let c = Math.ceil(n / max); c <= Math.floor(n / 2); c++) if (c !== k) cands.push(c);
    cands.sort(function (a, b) { return Math.abs(a - k) - Math.abs(b - k); });
    for (const c of cands) {
      const r = tryK(ids, met, c, rnd, attempts, max);
      if (r.repeats < res.repeats) res = r;
      if (res.repeats === 0) break;
    }
  }
  return res;
}

// Reparte N salas entre os níveis: pelo menos uma por nível, nunca mais salas
// que alunos, sempre dando a próxima sala ao nível com mais alunos por sala.
function allocateRooms(counts, N) {
  const levels = Object.keys(counts).filter(function (l) { return counts[l] > 0; });
  const alloc = {};
  if (!levels.length) return alloc;
  const total = levels.reduce(function (s, l) { return s + counts[l]; }, 0);
  const target = Math.max(levels.length, Math.min(N, total));
  levels.forEach(function (l) { alloc[l] = 1; });
  let left = target - levels.length;
  while (left > 0) {
    let best = null;
    let bestLoad = -1;
    for (const l of levels) {
      if (alloc[l] >= counts[l]) continue;
      const load = counts[l] / alloc[l];
      if (load > bestLoad) { bestLoad = load; best = l; }
    }
    if (!best) break;
    alloc[best]++;
    left--;
  }
  return alloc;
}

// students: [{id, level}]. met: Set de pares que já conversaram em rodadas anteriores.
// opts.rooms: número total de salas desejado (opcional; sem isso o sistema calcula).
// opts.levels: ordem dos níveis. Retorna { rooms: [{level, members:[ids]}], repeats }.
// Nível com um único aluno não vira sala sozinha: o aluno entra na menor sala existente.
function buildRound(students, met, opts) {
  const o = opts || {};
  const max = o.max || GROUP_MAX;
  const rnd = o.rnd || Math.random;
  const levels = o.levels || Array.from(new Set(students.map(function (s) { return s.level; })));
  const byLevel = {};
  for (const s of students) (byLevel[s.level] = byLevel[s.level] || []).push(s.id);

  const active = levels.filter(function (l) { return (byLevel[l] || []).length >= 2; });
  const loners = levels
    .filter(function (l) { return (byLevel[l] || []).length === 1; })
    .map(function (l) { return { id: byLevel[l][0], level: l }; });

  let alloc = {};
  if (o.rooms) {
    const counts = {};
    active.forEach(function (l) { counts[l] = byLevel[l].length; });
    alloc = allocateRooms(counts, Number(o.rooms));
  }

  const rooms = [];
  let repeats = 0;
  for (const level of active) {
    const res = formGroupsForLevel(byLevel[level], met, { rnd: rnd, max: max, attempts: o.attempts, k: alloc[level] });
    repeats += res.repeats;
    for (const g of res.groups) rooms.push({ level: level, members: g });
  }
  for (const l of loners) {
    if (!rooms.length) { rooms.push({ level: l.level, members: [l.id] }); continue; }
    const target = rooms.slice().sort(function (a, b) { return a.members.length - b.members.length; })[0];
    target.members.push(l.id);
  }
  return { rooms: rooms, repeats: repeats };
}

module.exports = { GROUP_MAX, shuffle, splitInto, chooseK, pairKey, countRepeats, allocateRooms, buildRound };
