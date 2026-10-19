// Parties entre bots uniquement : vérifie que le moteur termine toujours et que les cartes sont conservées.
const E = require('../engine');
const B = require('../bot');
const assert = require('assert');

function total(state) {
  const c = {};
  const add = (v) => (c[v] = (c[v] || 0) + 1);
  state.players.forEach((p) => { p.hand.forEach(add); p.trios.forEach((t) => { add(t); add(t); add(t); }); });
  state.middle.forEach((m) => m && add(m.v));
  state.revealed.forEach((r) => r.src.type === 'hand' && add(r.v));
  for (let v = 1; v <= 12; v++) assert.strictEqual(c[v], 3, 'valeur ' + v + ' : ' + c[v]);
}

function play(n, mode, teams, levels) {
  const players = Array.from({ length: n }, (_, i) => ({ id: 'b' + i, name: 'Bot' + i, isBot: true, level: levels[i % levels.length] }));
  const s = E.createGame({ players, mode, teams });
  let steps = 0;
  while (s.phase !== 'over') {
    if (++steps > 5000) throw new Error('trop long');
    if (s.phase === 'swap') {
      for (const p of s.players) if (s.swap && s.swap.teams.includes(p.team) && !(p.id in s.swap.picks)) E.chooseSwap(s, p.id, B.chooseSwapIndex(s, p.id));
      continue;
    }
    if (s.phase === 'resolve') { E.finishResolve(s); total(s); continue; }
    const src = B.chooseReveal(s);
    E.reveal(s, E.current(s).id, src);
  }
  return s;
}

const stats = {};
let games = 0;
for (const [n, mode, teams] of [[3,'simple',false],[4,'simple',false],[5,'spicy',false],[6,'simple',false],[4,'simple',true],[6,'spicy',true],[3,'spicy',false]]) {
  for (let i = 0; i < 300; i++) {
    const s = play(n, mode, teams, ['expert', 'facile', 'normal']);
    games++;
    const w = s.winner;
    const key = `${n}${mode[0]}${teams?'T':''}`;
    stats[key] = stats[key] || { turns: 0, reasons: {}, winners: {} };
    stats[key].turns += s.turnNo;
    stats[key].reasons[w.reason] = (stats[key].reasons[w.reason] || 0) + 1;
    if (!teams) { const lvl = s.players.find((p) => p.id === w.ids[0])?.level || 'none'; stats[key].winners[lvl] = (stats[key].winners[lvl]||0)+1; }
  }
}
for (const k in stats) { stats[k].turns = Math.round(stats[k].turns / 300); }
console.log(games, 'parties OK');
console.log(JSON.stringify(stats, null, 1));
