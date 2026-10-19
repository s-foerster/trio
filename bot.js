/**
 * Bots de Trio.
 *
 * Un bot ne triche pas : il connaît sa main et ce qui a été révélé publiquement
 * (cartes du milieu déjà vues, début / fin connus des mains des autres).
 * Sa mémoire dépend du niveau : chaque information vue est retenue avec une
 * probabilité fixe (facile 45 %, normal 80 %, expert 100 %), de façon stable.
 */
const { VALUES, linked, playerById, current, sideTrios } = require('./engine');

const MEMORY = { facile: 0.45, normal: 0.8, expert: 1 };

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function remembers(bot, stamp) {
  const rate = MEMORY[bot.level] ?? MEMORY.normal;
  return rate >= 1 || hash32(bot.id + ':' + stamp) < rate;
}

/** Préfixe dont le bot se souvient (s'arrête au premier oubli). */
function rememberedPrefix(bot, arr) {
  const out = [];
  for (const e of arr) {
    if (!remembers(bot, e.s)) break;
    out.push(e.v);
  }
  return out;
}

function comb(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/**
 * Ce que le bot sait au moment de choisir.
 * Renvoie, pour chaque source possible, soit une valeur connue, soit une distribution.
 */
function analyse(state, bot) {
  const counts = {};
  for (const v of VALUES) counts[v] = 3;
  for (const p of state.players) for (const t of p.trios) counts[t] -= 3;
  for (const v of bot.hand) counts[v]--;
  for (const r of state.revealed) {
    // Les cartes révélées de la main du bot ne sont plus dans bot.hand : on les compte ici.
    counts[r.v]--;
  }

  // Cartes révélées ce tour-ci, par extrémité de main
  const taken = {};
  for (const r of state.revealed) {
    if (r.src.type !== 'hand') continue;
    const k = r.src.target + ':' + r.src.end;
    taken[k] = (taken[k] || 0) + 1;
  }

  const sources = [];
  // Milieu
  state.middle.forEach((c, i) => {
    if (!c || c.up) return;
    const known = c.known && remembers(bot, c.known) ? c.v : null;
    if (known !== null) counts[known]--;
    sources.push({ src: { type: 'middle', index: i }, known, kind: 'middle' });
  });

  // Mains
  const handInfo = [];
  for (const p of state.players) {
    if (!p.hand.length) continue;
    if (p.id === bot.id) {
      sources.push({ src: { type: 'hand', target: p.id, end: 'low' }, known: p.hand[0], kind: 'own', seq: p.hand.slice() });
      sources.push({ src: { type: 'hand', target: p.id, end: 'high' }, known: p.hand[p.hand.length - 1], kind: 'own', seq: p.hand.slice().reverse() });
      continue;
    }
    const tl = taken[p.id + ':low'] || 0;
    const th = taken[p.id + ':high'] || 0;
    const startLen = p.hand.length + tl + th;
    let low = rememberedPrefix(bot, p.pubLow);
    let high = rememberedPrefix(bot, p.pubHigh);
    if (low.length + high.length > startLen) high = high.slice(0, Math.max(0, startLen - low.length));
    // Retirer de la réserve inconnue ce qui est connu et encore en main
    low.slice(tl).forEach((v) => counts[v]--);
    high.slice(th).forEach((v) => counts[v]--);
    const lowRest = low.slice(tl);
    const highRest = high.slice(th);
    const unknownCount = Math.max(0, p.hand.length - lowRest.length - highRest.length);
    handInfo.push({ p, lowRest, highRest, unknownCount });
  }
  for (const v of VALUES) counts[v] = Math.max(0, counts[v]);
  const pool = VALUES.reduce((s, v) => s + counts[v], 0);

  for (const h of handInfo) {
    for (const end of ['low', 'high']) {
      const rest = end === 'low' ? h.lowRest : h.highRest;
      const src = { type: 'hand', target: h.p.id, end };
      if (rest.length) {
        sources.push({ src, known: rest[0], kind: 'other', seq: rest });
      } else {
        sources.push({ src, known: null, kind: 'other', n: Math.max(1, h.unknownCount), end });
      }
    }
  }

  // Probabilités pour les sources inconnues
  for (const s of sources) {
    if (s.known !== null) continue;
    s.prob = {};
    if (!pool) { VALUES.forEach((v) => (s.prob[v] = 0)); continue; }
    if (s.kind === 'middle') {
      VALUES.forEach((v) => (s.prob[v] = counts[v] / pool));
    } else {
      // Plus petite (ou plus grande) de n cartes tirées dans la réserve inconnue
      const n = Math.min(s.n, pool);
      const total = comb(pool, n);
      const order = s.end === 'low' ? VALUES : VALUES.slice().reverse();
      let beyond = pool; // cartes >= v (ou <= v pour "high")
      for (const v of order) {
        const pAtLeast = comb(beyond, n) / total;
        const pNext = comb(beyond - counts[v], n) / total;
        s.prob[v] = Math.max(0, pAtLeast - pNext);
        beyond -= counts[v];
      }
    }
  }
  return { sources, counts };
}

/** Combien de cartes de valeur v le bot peut obtenir à coup sûr depuis cette source. */
function sureRun(s, v) {
  if (s.known !== v) return 0;
  if (!s.seq) return 1;
  let k = 0;
  while (k < s.seq.length && s.seq[k] === v) k++;
  return k;
}

function valueWeight(state, bot, v) {
  if (v === 7) return 4;
  const trios = sideTrios(state, bot);
  if (state.mode === 'simple' && trios.length >= 2) return 3;
  if (state.mode === 'spicy' && trios.some((t) => linked(t, v))) return 3.5;
  if (state.mode === 'spicy' && VALUES.some((o) => linked(o, v))) return 1.1;
  return 1;
}

/** Choisit la prochaine carte à révéler pour le bot dont c'est le tour. */
function chooseReveal(state, rng = Math.random) {
  const bot = current(state);
  const { sources } = analyse(state, bot);
  if (!sources.length) return null;
  const target = state.revealed.length ? state.revealed[0].v : null;
  const need = 3 - state.revealed.length;

  const candidates = target !== null ? [target] : VALUES;
  let best = null;
  for (const v of candidates) {
    // Sources sûres (avec les doublons accessibles à la suite) puis meilleures probabilités
    let sure = 0;
    const sureSrcs = [];
    // Sa propre main est triée : les copies de v sont accessibles si elles touchent un bout
    const h = bot.hand;
    if (h.length && (h[0] === v || h[h.length - 1] === v)) {
      const own = h.filter((x) => x === v).length;
      sure += own;
      sureSrcs.push({ src: { type: 'hand', target: bot.id, end: h[0] === v ? 'low' : 'high' }, run: own });
    }
    for (const s of sources) {
      if (s.kind === 'own') continue;
      const run = sureRun(s, v);
      if (!run) continue;
      sure += run;
      sureSrcs.push({ ...s, run });
    }
    const probs = sources
      .filter((s) => s.known === null)
      .map((s) => ({ s, p: s.prob[v] || 0 }))
      .sort((a, b) => b.p - a.p);
    let p = 1;
    let missing = Math.max(0, need - sure);
    for (let i = 0; i < missing; i++) p *= probs[i] ? probs[i].p : 0;
    const score = p * valueWeight(state, bot, v) + (sure >= need ? 10 : 0) + rng() * 1e-6;
    if (!best || score > best.score) best = { v, score, sureSrcs, probs };
  }

  if (best.sureSrcs.length) return best.sureSrcs[0].src;
  if (best.probs.length && best.probs[0].p > 0) return best.probs[0].s.src;

  // Rien de prometteur : révéler une carte inconnue (pour apprendre), sinon n'importe laquelle
  const unknown = sources.filter((s) => s.known === null);
  const pick = (unknown.length ? unknown : sources)[Math.floor(rng() * (unknown.length || sources.length))];
  return pick.src;
}

/** En mode équipes : carte à donner au partenaire (un nombre isolé, jamais un 7 si possible). */
function chooseSwapIndex(state, botId, rng = Math.random) {
  const bot = playerById(state, botId);
  const count = {};
  bot.hand.forEach((v) => (count[v] = (count[v] || 0) + 1));
  let idx = bot.hand.map((v, i) => i).filter((i) => count[bot.hand[i]] === 1 && bot.hand[i] !== 7);
  if (!idx.length) idx = bot.hand.map((v, i) => i).filter((i) => count[bot.hand[i]] < 3);
  if (!idx.length) idx = bot.hand.map((v, i) => i);
  return idx[Math.floor(rng() * idx.length)];
}

module.exports = { chooseReveal, chooseSwapIndex, MEMORY };
