/**
 * Moteur de règles de Trio (Kaya Miyano, Cogitum / Cocktail Games).
 *
 * 36 cartes : les nombres 1 à 12, trois fois chacun.
 * À son tour, on révèle des cartes une par une :
 *   - une carte face cachée du milieu,
 *   - ou la plus petite / la plus grande carte de la main d'un joueur (soi compris).
 * On continue tant que les cartes révélées sont identiques.
 *   - 3 cartes identiques : on gagne ce trio.
 *   - 2 nombres différents : le tour s'arrête et les cartes retournent à leur place.
 * Victoire :
 *   - mode simple : 3 trios, ou le trio de 7 ;
 *   - mode piquant : 2 trios liés (somme ou différence = 7), ou le trio de 7.
 * Mode équipes (4 ou 6 joueurs) : équipes de 2 assises face à face, toutes les cartes
 * distribuées, échange d'une carte entre partenaires au début et après chaque trio
 * gagné par une équipe adverse.
 *
 * Ce module ne fait aucune entrée/sortie : le serveur l'appelle, il ne fait que modifier l'état.
 */

const VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

const SETUP = {
  3: { hand: 9, middle: 9 },
  4: { hand: 7, middle: 8 },
  5: { hand: 6, middle: 6 },
  6: { hand: 5, middle: 6 },
};
const TEAM_SETUP = {
  4: { hand: 9, middle: 0 },
  6: { hand: 6, middle: 0 },
};

class RuleError extends Error {}

/** Deux trios sont liés si la somme ou la différence de leurs nombres vaut 7. */
function linked(a, b) {
  return a !== b && (a + b === 7 || Math.abs(a - b) === 7);
}

/** Nombres liés à v (affichés dans les coins des cartes en mode piquant). */
function linksOf(v) {
  return [7 - v, v - 7, v + 7].filter((x) => x >= 1 && x <= 12 && x !== 7 && x !== v).sort((a, b) => a - b);
}

function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const byNum = (a, b) => a - b;

/**
 * @param {object} p
 * @param {{id:string,name:string,isBot?:boolean,level?:string}[]} p.players  dans l'ordre des sièges
 * @param {'simple'|'spicy'} p.mode
 * @param {boolean} p.teams
 */
function createGame({ players, mode = 'simple', teams = false, rng = Math.random }) {
  const n = players.length;
  if (n < 3 || n > 6) throw new RuleError('Il faut entre 3 et 6 joueurs.');
  if (teams && n !== 4 && n !== 6) throw new RuleError('Le mode équipes se joue à 4 ou 6 joueurs.');
  const setup = teams ? TEAM_SETUP[n] : SETUP[n];
  const nTeams = teams ? n / 2 : 0;

  const deck = shuffle(VALUES.flatMap((v) => [v, v, v]), rng);
  const state = {
    mode: mode === 'spicy' ? 'spicy' : 'simple',
    teams: !!teams,
    nTeams,
    players: players.map((p, i) => ({
      id: p.id,
      name: p.name,
      isBot: !!p.isBot,
      level: p.level || 'normal',
      team: teams ? i % nTeams : null,
      hand: deck.splice(0, setup.hand).sort(byNum),
      trios: [],
      // Connaissance publique : début / fin connus de la main triée (cartes déjà vues).
      pubLow: [],
      pubHigh: [],
    })),
    middle: deck.splice(0, setup.middle).map((v) => ({ v, up: false, known: null })),
    turn: Math.floor(rng() * n),
    revealed: [],
    phase: 'play', // 'swap' | 'play' | 'resolve' | 'over'
    resolve: null, // 'trio' | 'fail'
    swap: null,
    winner: null,
    stamp: 0,
    turnNo: 1,
    log: [],
  };
  addLog(state, `${state.players[state.turn].name} commence.`);
  if (state.teams) startSwap(state, [...Array(nTeams).keys()]);
  return state;
}

function addLog(state, text) {
  state.log.push(text);
  if (state.log.length > 30) state.log.shift();
}

const newStamp = (state) => ++state.stamp;
const playerById = (state, id) => state.players.find((p) => p.id === id);
const current = (state) => state.players[state.turn];

function teamName(t) {
  return ['Équipe bleue', 'Équipe orange', 'Équipe verte'][t] || `Équipe ${t + 1}`;
}

// ── Échanges en mode équipes ─────────────────────────────────────────────────
function teamMembers(state, t) {
  return state.players.filter((p) => p.team === t);
}

function startSwap(state, teams) {
  const eligible = teams.filter((t) => teamMembers(state, t).every((p) => p.hand.length > 0));
  if (!eligible.length) return;
  state.phase = 'swap';
  state.swap = { teams: eligible, picks: {} };
}

/** Un joueur choisit la carte (index dans sa main) à donner à son partenaire. */
function chooseSwap(state, playerId, index) {
  if (state.phase !== 'swap') throw new RuleError("Ce n'est pas le moment d'échanger.");
  const p = playerById(state, playerId);
  if (!p || !state.swap.teams.includes(p.team)) throw new RuleError("Ton équipe n'échange pas maintenant.");
  if (!Number.isInteger(index) || index < 0 || index >= p.hand.length) throw new RuleError('Carte invalide.');
  state.swap.picks[playerId] = index;

  // Échange dès que les deux partenaires ont choisi
  for (const t of state.swap.teams) {
    const [a, b] = teamMembers(state, t);
    if (!(a.id in state.swap.picks) || !(b.id in state.swap.picks)) return;
  }
  for (const t of state.swap.teams) {
    const [a, b] = teamMembers(state, t);
    const ca = a.hand.splice(state.swap.picks[a.id], 1)[0];
    const cb = b.hand.splice(state.swap.picks[b.id], 1)[0];
    a.hand.push(cb); a.hand.sort(byNum);
    b.hand.push(ca); b.hand.sort(byNum);
    for (const p of [a, b]) { p.pubLow = []; p.pubHigh = []; }
    addLog(state, `${teamName(t)} a échangé une carte.`);
  }
  state.swap = null;
  state.phase = 'play';
  checkStuck(state);
}

// ── Révélations ──────────────────────────────────────────────────────────────
/** Liste des actions possibles pour le joueur dont c'est le tour. */
function legalSources(state) {
  if (state.phase !== 'play') return [];
  const out = [];
  state.middle.forEach((c, i) => { if (c && !c.up) out.push({ type: 'middle', index: i }); });
  for (const p of state.players) {
    if (p.hand.length) {
      out.push({ type: 'hand', target: p.id, end: 'low' });
      out.push({ type: 'hand', target: p.id, end: 'high' });
    }
  }
  return out;
}

/**
 * Révèle une carte.
 * @param src {type:'middle', index} | {type:'hand', target:playerId, end:'low'|'high'}
 * @returns la valeur révélée
 */
function reveal(state, playerId, src) {
  if (state.phase !== 'play') throw new RuleError("Ce n'est pas le moment de révéler une carte.");
  const me = current(state);
  if (me.id !== playerId) throw new RuleError("Ce n'est pas ton tour.");
  if (!src || typeof src !== 'object') throw new RuleError('Action invalide.');

  let v;
  let entry;
  if (src.type === 'middle') {
    const c = state.middle[src.index];
    if (!c || c.up) throw new RuleError('Cette carte ne peut pas être retournée.');
    c.up = true;
    v = c.v;
    entry = { v, src: { type: 'middle', index: src.index } };
  } else if (src.type === 'hand') {
    const t = playerById(state, src.target);
    if (!t) throw new RuleError('Joueur inconnu.');
    if (src.end !== 'low' && src.end !== 'high') throw new RuleError('Choisis la plus petite ou la plus grande carte.');
    if (!t.hand.length) throw new RuleError(`${t.name} n'a plus de carte en main.`);
    v = src.end === 'low' ? t.hand.shift() : t.hand.pop();
    entry = { v, src: { type: 'hand', target: t.id, end: src.end } };
  } else {
    throw new RuleError('Action invalide.');
  }
  state.revealed.push(entry);
  addLog(state, `${me.name} révèle ${describeSource(state, entry.src, me.id)} : ${v}.`);

  const first = state.revealed[0].v;
  if (v !== first) {
    state.phase = 'resolve';
    state.resolve = 'fail';
  } else if (state.revealed.length === 3) {
    state.phase = 'resolve';
    state.resolve = 'trio';
  }
  return v;
}

function describeSource(state, src, actorId) {
  if (src.type === 'middle') return 'une carte du milieu';
  const t = playerById(state, src.target);
  const which = src.end === 'low' ? 'la plus petite carte' : 'la plus grande carte';
  return t.id === actorId ? `sa ${which.replace('la ', '')}` : `${which} de ${t.name}`;
}

/** À appeler après la pause d'affichage : range les cartes ou attribue le trio. */
function finishResolve(state) {
  if (state.phase !== 'resolve') return;
  const me = current(state);
  const rev = state.revealed;

  // Cartes révélées depuis chaque extrémité de chaque main, dans l'ordre
  const seqs = {};
  for (const r of rev) {
    if (r.src.type !== 'hand') continue;
    const k = r.src.target + ':' + r.src.end;
    (seqs[k] = seqs[k] || []).push(r.v);
  }

  if (state.resolve === 'fail') {
    for (const r of rev) {
      if (r.src.type === 'middle') {
        const c = state.middle[r.src.index];
        c.up = false;
        c.known = newStamp(state); // tout le monde l'a vue
      }
    }
    for (const p of state.players) {
      const low = seqs[p.id + ':low'] || [];
      const high = seqs[p.id + ':high'] || [];
      if (!low.length && !high.length) continue;
      p.hand.push(...low, ...high);
      p.hand.sort(byNum);
      if (low.length) {
        p.pubLow = low.map((v) => ({ v, s: newStamp(state) })).concat(p.pubLow.slice(low.length));
      }
      if (high.length) {
        p.pubHigh = high.map((v) => ({ v, s: newStamp(state) })).concat(p.pubHigh.slice(high.length));
      }
      capKnowledge(p);
    }
    addLog(state, `Raté ! Les cartes retournent à leur place.`);
  } else {
    const value = rev[0].v;
    for (const r of rev) if (r.src.type === 'middle') state.middle[r.src.index] = null;
    for (const p of state.players) {
      const low = (seqs[p.id + ':low'] || []).length;
      const high = (seqs[p.id + ':high'] || []).length;
      if (low) p.pubLow = p.pubLow.length > low ? p.pubLow.slice(low) : [];
      if (high) p.pubHigh = p.pubHigh.length > high ? p.pubHigh.slice(high) : [];
      capKnowledge(p);
    }
    me.trios.push(value);
    addLog(state, `${me.name} remporte le trio de ${value} !`);
    const win = checkWin(state, me);
    if (win) {
      state.revealed = [];
      state.resolve = null;
      state.phase = 'over';
      state.winner = win;
      addLog(state, win.text);
      return;
    }
  }

  const wonBy = state.resolve === 'trio' ? me : null;
  state.revealed = [];
  state.resolve = null;
  state.phase = 'play';
  state.turn = (state.turn + 1) % state.players.length;
  state.turnNo++;
  if (state.teams && wonBy) {
    const others = [...Array(state.nTeams).keys()].filter((t) => t !== wonBy.team);
    startSwap(state, others);
  }
  checkStuck(state);
}

function capKnowledge(p) {
  if (p.pubLow.length > p.hand.length) p.pubLow.length = p.hand.length;
  if (p.pubHigh.length > p.hand.length) p.pubHigh.length = p.hand.length;
}

/** Trios d'un camp (le joueur seul, ou son équipe). */
function sideTrios(state, player) {
  if (!state.teams) return player.trios;
  return teamMembers(state, player.team).flatMap((p) => p.trios);
}

function checkWin(state, player) {
  const trios = sideTrios(state, player);
  const ids = state.teams ? teamMembers(state, player.team).map((p) => p.id) : [player.id];
  const who = state.teams ? teamName(player.team) : player.name;
  if (trios.includes(7)) return { ids, team: player.team, reason: 'seven', text: `${who} gagne avec le trio de 7 !` };
  if (state.mode === 'simple' && trios.length >= 3) {
    return { ids, team: player.team, reason: 'three', text: `${who} gagne avec 3 trios !` };
  }
  if (state.mode === 'spicy') {
    for (let i = 0; i < trios.length; i++) {
      for (let j = i + 1; j < trios.length; j++) {
        if (linked(trios[i], trios[j])) {
          return { ids, team: player.team, reason: 'linked', pair: [trios[i], trios[j]], text: `${who} gagne avec les trios liés ${trios[i]} et ${trios[j]} !` };
        }
      }
    }
  }
  return null;
}

/** Sécurité : plus aucune carte à révéler (ne devrait pas arriver, le trio de 7 finit toujours la partie). */
function checkStuck(state) {
  if (state.phase !== 'play') return;
  if (legalSources(state).length === 0) {
    state.phase = 'over';
    state.winner = { ids: [], reason: 'none', text: 'Plus aucune carte : égalité.' };
    addLog(state, state.winner.text);
  }
}

/** État visible par un joueur (les mains des autres et le milieu restent cachés). */
function viewFor(state, viewerId) {
  const viewer = playerById(state, viewerId);
  return {
    mode: state.mode,
    teams: state.teams,
    phase: state.phase,
    resolve: state.resolve,
    turn: state.turn,
    turnNo: state.turnNo,
    currentId: current(state).id,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      team: p.team,
      handCount: p.hand.length,
      hand: p.id === viewerId || state.phase === 'over' ? p.hand.slice() : undefined,
      trios: p.trios.slice(),
    })),
    middle: state.middle.map((c) => (c === null ? null : c.up ? { up: true, v: c.v } : { up: false })),
    revealed: state.revealed.map((r) => ({ v: r.v, src: r.src })),
    swap: state.swap
      ? {
          teams: state.swap.teams,
          mustPick: !!viewer && state.swap.teams.includes(viewer.team) && !(viewerId in state.swap.picks),
          picked: Object.keys(state.swap.picks),
        }
      : null,
    winner: state.winner,
    log: state.log.slice(-12),
  };
}

module.exports = {
  VALUES, SETUP, TEAM_SETUP, RuleError,
  linked, linksOf, shuffle, teamName,
  createGame, reveal, finishResolve, chooseSwap, legalSources, viewFor,
  playerById, current, sideTrios,
};
