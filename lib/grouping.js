'use strict';
// Formação de salas por nível. Sem dependências: roda no Node (servidor e testes).

const GROUP_MAX = 4;
const GROUP_MIN = 3;

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

// Opções de tamanhos de sala para n alunos, todas entre min e max (3 a 4). Para cada número de salas k há um único jeito (n = 4a + 3b).
// Ordem de preferência: primeiro os números de salas em que a maior sala não passa de k (assim, na rodada seguinte, ninguém precisa repetir parceiro),
// do menor para o maior número de salas (salas mais cheias); depois os demais.
function sizeOptions(n, max, min) {
  const out = [];
  for (let k = Math.ceil(n / max); k <= Math.floor(n / min); k++) out.push(splitInto(n, k));
  out.sort(function (a, b) {
    const fa = a[0] <= a.length ? 0 : 1;
    const fb = b[0] <= b.length ? 0 : 1;
    return fa - fb || a.length - b.length;
  });
  return out;
}
// (mantido por compatibilidade) menor número de salas que permite trocar todos os parceiros.
function chooseK(n, max) {
  const opt = sizeOptions(n, max || GROUP_MAX, GROUP_MIN);
  return opt.length ? opt[0].length : Math.max(1, Math.ceil(n / (max || GROUP_MAX)));
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

// Busca exata: coloca cada aluno numa sala sem ninguém que ele já encontrou. Começa pelos alunos com mais restrições e volta atrás quando trava.
function solveZero(ids, met, sizes, rnd, tries) {
  const adj = new Map();
  ids.forEach(function (a) {
    const set = new Set();
    ids.forEach(function (b) { if (a !== b && met.has(pairKey(a, b))) set.add(b); });
    adj.set(a, set);
  });
  for (let t = 0; t < tries; t++) {
    const order = shuffle(ids, rnd).sort(function (a, b) { return adj.get(b).size - adj.get(a).size; });
    const groups = sizes.map(function () { return []; });
    let nodes = 0;
    const place = function (i) {
      if (i === order.length) return true;
      if (++nodes > 20000) return false;
      const id = order[i];
      const seenEmpty = new Set();
      const idx = shuffle(groups.map(function (_, g) { return g; }), rnd);
      for (const g of idx) {
        const grp = groups[g];
        if (grp.length >= sizes[g]) continue;
        if (!grp.length) { if (seenEmpty.has(sizes[g])) continue; seenEmpty.add(sizes[g]); }
        let clash = false;
        for (const m of grp) { if (adj.get(id).has(m)) { clash = true; break; } }
        if (clash) continue;
        grp.push(id);
        if (place(i + 1)) return true;
        grp.pop();
      }
      return false;
    };
    if (place(0)) return groups;
  }
  return null;
}

// Plano B quando é impossível não repetir: sorteia e troca alunos de sala até sobrar o mínimo de pares repetidos.
function tryBest(ids, met, sizes, rnd, attempts) {
  let best = null;
  let bestScore = Infinity;
  for (let t = 0; t < attempts && bestScore > 0; t++) {
    const sh = shuffle(ids, rnd);
    const groups = [];
    let p = 0;
    for (const sz of sizes) { groups.push(sh.slice(p, p + sz)); p += sz; }
    let sc = countRepeats(groups, met);
    if (sc > 0) sc = improve(groups, met);
    if (sc < bestScore) { best = groups; bestScore = sc; }
  }
  return { groups: best || [], repeats: bestScore === Infinity ? 0 : bestScore };
}

// Salas de um nível: 3 a 4 alunos por sala (5 só se for o único jeito, com 5 alunos no nível).
// opts.k fixa o número de salas (escolha do professor; nesse caso o tamanho segue o número pedido).
function formGroupsForLevel(ids, met, opts) {
  const o = opts || {};
  const max = o.max || GROUP_MAX;
  const min = o.min || GROUP_MIN;
  const rnd = o.rnd || Math.random;
  const attempts = o.attempts || 200;
  const n = ids.length;
  let options = sizeOptions(n, max, min);
  if (o.k) options = [splitInto(n, Math.min(n, Math.max(1, o.k)))];   // número de salas escolhido pelo professor: vale como ele pediu
  else if (!options.length) return { groups: [shuffle(ids, rnd)], repeats: 0 };   // 1, 2 ou 5 alunos: uma sala só
  let best = null;
  for (const sizes of options) {
    const g = solveZero(ids, met, sizes, rnd, 30);
    if (g) return { groups: g, repeats: 0 };
  }
  // não dá para evitar repetição: escolhe o arranjo com menos pares repetidos
  for (const sizes of options) {
    const r = tryBest(ids, met, sizes, rnd, attempts);
    if (!best || r.repeats < best.repeats) best = r;
  }
  return best;
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
// Cada sala tem de 3 a 4 alunos do mesmo nível. Nível com menos de 3 alunos não forma sala própria:
// os alunos entram nas menores salas dos outros níveis (sem repetir parceiro, se der). Se só existir esse nível, ficam todos juntos.
function buildRound(students, met, opts) {
  const o = opts || {};
  const min = o.min || GROUP_MIN;
  const max = o.max || GROUP_MAX;
  const rnd = o.rnd || Math.random;
  const levels = o.levels || Array.from(new Set(students.map(function (s) { return s.level; })));
  const byLevel = {};
  for (const s of students) (byLevel[s.level] = byLevel[s.level] || []).push(s.id);

  const active = levels.filter(function (l) { return (byLevel[l] || []).length >= min; });
  const small = [];
  levels.forEach(function (l) {
    const list = byLevel[l] || [];
    if (list.length && list.length < min) list.forEach(function (id) { small.push({ id: id, level: l }); });
  });

  let alloc = {};
  if (o.rooms) {
    const counts = {};
    active.forEach(function (l) { counts[l] = byLevel[l].length; });
    alloc = allocateRooms(counts, Number(o.rooms));
  }

  const rooms = [];
  for (const level of active) {
    const res = formGroupsForLevel(byLevel[level], met, { rnd: rnd, max: max, min: min, attempts: o.attempts, k: alloc[level] });
    for (const g of res.groups) rooms.push({ level: level, members: g });
  }
  if (!rooms.length && small.length) rooms.push({ level: small[0].level, members: [] });
  for (const l of small) {
    const conflicts = function (r) { return r.members.filter(function (m) { return met.has(pairKey(m, l.id)); }).length; };
    const target = rooms.slice().sort(function (a, b) { return conflicts(a) - conflicts(b) || a.members.length - b.members.length; })[0];
    target.members.push(l.id);
  }
  return { rooms: rooms, repeats: countRepeats(rooms.map(function (r) { return r.members; }), met) };
}

module.exports = { GROUP_MAX, GROUP_MIN, sizeOptions, solveZero, shuffle, splitInto, chooseK, pairKey, countRepeats, allocateRooms, buildRound };
