// Test bout en bout : vrai serveur, vrais WebSockets (client natif de Node >= 22).
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const PORT = 3990;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, TRIO_FAST: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });

function client(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const c = { ws, name, room: null, welcome: null, errors: [], waiters: [] };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'state') c.room = m.room;
    if (m.t === 'welcome') c.welcome = m;
    if (m.t === 'error') c.errors.push(m.message);
    c.waiters = c.waiters.filter((w) => !w(m));
  };
  c.send = (m) => ws.send(JSON.stringify(m));
  c.until = (pred, ms = 8000) => new Promise((res, rej) => {
    if (c.room && pred(c.room)) return res(c.room);
    const t = setTimeout(() => rej(new Error(name + ' timeout')), ms);
    c.waiters.push((m) => { if (m.t === 'state' && pred(m.room)) { clearTimeout(t); res(m.room); return true; } return false; });
  });
  c.open = new Promise((r) => (ws.onopen = r));
  return c;
}

(async () => {
  await new Promise((r) => srv.stdout.once('data', r));
  // HTTP statique
  const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
  assert(html.includes('<title>Trio</title>'));
  assert.strictEqual((await fetch(`http://127.0.0.1:${PORT}/../server.js`)).status, 404);

  const a = client('Alice'); await a.open;
  a.send({ t: 'create', name: 'Alice' });
  const r1 = await a.until((r) => r.members.length === 1);
  const code = r1.code;
  assert.match(code, /^\d{4}$/);

  const b = client('Bob'); await b.open;
  b.send({ t: 'join', code, name: 'Bob' });
  await a.until((r) => r.members.length === 2);
  b.send({ t: 'addBot', level: 'expert' }); // pas l'hôte -> erreur
  await new Promise((r) => setTimeout(r, 100));
  assert(b.errors.some((e) => e.includes("l'hôte")));
  a.send({ t: 'addBot', level: 'expert' });
  a.send({ t: 'addBot', level: 'facile' });
  a.send({ t: 'options', mode: 'spicy', teams: true });
  await a.until((r) => r.members.length === 4 && r.options.teams);
  a.send({ t: 'start' });
  await a.until((r) => r.game);

  // Bob se reconnecte (nouvelle socket, resume)
  const bw = b.welcome; b.ws.close();
  const b2 = client('Bob2'); await b2.open;
  b2.send({ t: 'resume', code, playerId: bw.playerId, secret: bw.secret });
  await b2.until((r) => r.game);

  // Les deux humains jouent au hasard parmi les coups permis jusqu'à la fin
  const players = [a, b2];
  let moves = 0;
  const done = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('partie trop longue')), 30000);
    const tick = () => {
      for (const c of players) {
        const g = c.room && c.room.game;
        if (!g) continue;
        if (g.phase === 'over') { clearTimeout(t); return resolve(g); }
        // chacun ne voit que sa main
        g.players.forEach((p) => assert(p.id === c.room.you || p.hand === undefined));
        if (g.phase === 'swap' && g.swap.mustPick && !c.pending) {
          c.pending = true; c.send({ t: 'swap', index: 0 });
        } else if (g.phase === 'play' && g.currentId === c.room.you && !c.pending) {
          const opts = [];
          g.middle.forEach((m, i) => m && !m.up && opts.push({ type: 'middle', index: i }));
          g.players.forEach((p) => p.handCount && opts.push({ type: 'hand', target: p.id, end: Math.random() < 0.5 ? 'low' : 'high' }));
          c.pending = true; moves++;
          c.send({ t: 'reveal', src: opts[Math.floor(Math.random() * opts.length)] });
        }
      }
      setTimeout(tick, 15);
    };
    for (const c of players) { const om = c.ws.onmessage; c.ws.onmessage = (e) => { c.pending = false; om(e); }; }
    tick();
  });
  console.log('partie e2e finie :', done.winner.text, '| coups humains :', moves, '| erreurs :', a.errors.length + b2.errors.length);
  assert.strictEqual(a.errors.length + b2.errors.length, 0, [...a.errors, ...b2.errors].join(' / '));
  assert(done.players.every((p) => Array.isArray(p.hand))); // mains visibles à la fin

  // Retour au salon puis départ de l'hôte -> Bob devient hôte
  a.send({ t: 'backToLobby' });
  await b2.until((r) => !r.game);
  a.send({ t: 'leave' });
  const r3 = await b2.until((r) => r.members.length === 3);
  assert.strictEqual(r3.hostId, r3.you);

  // Code inconnu
  const c = client('Zoe'); await c.open;
  c.send({ t: 'join', code: '00x0', name: 'Zoe' });
  await new Promise((r) => setTimeout(r, 100));
  assert(c.errors[0].includes('Aucune partie'));

  // Joueur absent : un bot joue à sa place, la partie se termine quand même
  const d = client('Dan'); await d.open;
  d.send({ t: 'create', name: 'Dan' });
  await d.until((r) => r.members.length === 1);
  d.send({ t: 'addBot', level: 'normal' }); d.send({ t: 'addBot', level: 'normal' });
  await d.until((r) => r.members.length === 3);
  d.send({ t: 'start' });
  const dr = await d.until((r) => r.game);
  const dw = d.welcome; d.ws.close();
  const d2 = client('Dan2'); await new Promise((r) => setTimeout(r, 2500)); await d2.open;
  d2.send({ t: 'resume', code: dr.code, playerId: dw.playerId, secret: dw.secret });
  await d2.until((r) => r.game && r.game.turnNo > 3, 15000);

  console.log('e2e OK');
  srv.kill(); process.exit(0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
