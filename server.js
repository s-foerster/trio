/**
 * Serveur Trio : fichiers statiques + WebSocket (/ws).
 *
 * - Parties identifiées par un code à 4 chiffres (créer / rejoindre, comme Odin et Maboul).
 * - L'hôte ajoute ou retire des bots dans le salon, choisit le mode (simple / piquant) et les équipes.
 * - Reconnexion : le client garde { code, playerId, secret } et renvoie "resume" au rechargement.
 * - Un joueur déconnecté pendant son tour est joué par un bot au bout de 20 s.
 * - Fonctionne à la racine comme sous un sous-chemin (/trio/ derrière koyeb-apps) : le client
 *   n'utilise que des chemins relatifs.
 *
 * Aucune dépendance npm (WebSocket maison dans ws.js).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('./ws');
const E = require('./engine');
const B = require('./bot');

const PORT = Number(process.env.PORT) || 3004;
const PUBLIC = path.join(__dirname, 'public');
const MAX_PLAYERS = 6;
const DELAY = { bot: 1100, fail: 2200, trio: 1800, swap: 700, afk: 20000 };
// Tests : TRIO_FAST=1 accélère toutes les pauses
if (process.env.TRIO_FAST) for (const k in DELAY) DELAY[k] = k === 'afk' ? 300 : 5;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ── Fichiers statiques ───────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  if (url.pathname === '/cards/manifest.json') {
    // Images de cartes personnalisées (public/cards/1.png … 12.png, back.png) si présentes
    const has = (f) => fs.existsSync(path.join(PUBLIC, 'cards', f));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify({ faces: has('1.png'), back: has('back.png') }));
  }
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    fs.createReadStream(file).pipe(res);
  });
});

// ── Salons ───────────────────────────────────────────────────────────────────
/** @type {Map<string, any>} */
const rooms = new Map();
const newId = () => crypto.randomBytes(6).toString('hex');

function newCode() {
  for (let i = 0; i < 1000; i++) {
    const c = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    if (!rooms.has(c)) return c;
  }
  throw new Error('Plus de code disponible');
}

const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16);
const BOT_NAMES = ['Avocat', 'Kiwi', 'Mangue', 'Litchi', 'Papaye', 'Figue', 'Goyave', 'Prune', 'Myrtille', 'Grenade'];
const LEVEL_LABEL = { facile: 'facile', normal: 'normal', expert: 'expert' };

function createRoom(hostName) {
  const room = {
    code: newCode(),
    hostId: null,
    options: { mode: 'simple', teams: false },
    members: [],
    game: null,
    timer: null,
    afkTimer: null,
    lastActivity: Date.now(),
    finishedAt: null,
  };
  rooms.set(room.code, room);
  const m = addHuman(room, hostName);
  room.hostId = m.id;
  return { room, member: m };
}

function addHuman(room, name) {
  const m = { id: newId(), secret: newId() + newId(), name: cleanName(name) || 'Joueur', isBot: false, level: null, sockets: new Set(), disconnectedAt: null };
  room.members.push(m);
  return m;
}

function addBot(room, level) {
  const used = new Set(room.members.map((m) => m.name));
  const base = BOT_NAMES.find((n) => !used.has(n)) || 'Bot';
  const lvl = LEVEL_LABEL[level] ? level : 'normal';
  room.members.push({ id: 'bot-' + newId(), name: base, isBot: true, level: lvl, sockets: new Set() });
}

const humans = (room) => room.members.filter((m) => !m.isBot);
const connected = (m) => m.isBot || m.sockets.size > 0;

function roomView(room, viewer) {
  return {
    code: room.code,
    hostId: room.hostId,
    you: viewer.id,
    options: room.options,
    members: room.members.map((m) => ({ id: m.id, name: m.name, isBot: m.isBot, level: m.level, connected: connected(m) })),
    game: room.game ? E.viewFor(room.game, viewer.id) : null,
  };
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room) {
  room.lastActivity = Date.now();
  for (const m of room.members) {
    if (m.isBot) continue;
    const view = roomView(room, m);
    for (const ws of m.sockets) send(ws, { t: 'state', room: view });
  }
  schedule(room);
}

// ── Déroulement automatique (pauses, bots, joueurs absents) ──────────────────
function schedule(room) {
  clearTimeout(room.timer);
  room.timer = null;
  const g = room.game;
  if (!g || g.phase === 'over') {
    clearTimeout(room.afkTimer); room.afkTimer = null;
    return;
  }

  if (g.phase === 'resolve') {
    room.timer = setTimeout(() => { E.finishResolve(g); afterGameChange(room); }, g.resolve === 'trio' ? DELAY.trio : DELAY.fail);
    return;
  }

  if (g.phase === 'swap') {
    const botsToPick = g.players.filter((p) => g.swap.teams.includes(p.team) && !(p.id in g.swap.picks) && isAuto(room, p.id));
    if (botsToPick.length) {
      room.timer = setTimeout(() => {
        for (const p of botsToPick) {
          if (g.phase === 'swap' && !(p.id in g.swap.picks)) E.chooseSwap(g, p.id, B.chooseSwapIndex(g, p.id));
        }
        afterGameChange(room);
      }, DELAY.swap);
    }
    scheduleAfk(room);
    return;
  }

  const cur = E.current(g);
  if (isAuto(room, cur.id)) {
    room.timer = setTimeout(() => {
      if (room.game !== g || g.phase !== 'play' || E.current(g).id !== cur.id) return;
      const src = B.chooseReveal(g);
      if (src) E.reveal(g, cur.id, src);
      afterGameChange(room);
    }, DELAY.bot);
  } else {
    scheduleAfk(room);
  }
}

/** Joueur joué automatiquement : un bot, ou un humain absent depuis plus de 20 s. */
function isAuto(room, playerId) {
  const m = room.members.find((x) => x.id === playerId);
  if (!m) return true;
  if (m.isBot) return true;
  return m.sockets.size === 0 && m.disconnectedAt && Date.now() - m.disconnectedAt >= DELAY.afk;
}

function scheduleAfk(room) {
  clearTimeout(room.afkTimer);
  const waiting = room.members.filter((m) => !m.isBot && m.sockets.size === 0 && m.disconnectedAt);
  if (!waiting.length) return;
  const next = Math.min(...waiting.map((m) => m.disconnectedAt + DELAY.afk)) - Date.now();
  room.afkTimer = setTimeout(() => schedule(room), Math.max(200, next + 50));
}

function afterGameChange(room) {
  if (room.game && room.game.phase === 'over' && !room.finishedAt) room.finishedAt = Date.now();
  broadcast(room);
}

// ── Actions ──────────────────────────────────────────────────────────────────
class UserError extends Error {}

function requireHost(room, m) {
  if (room.hostId !== m.id) throw new UserError("Seul l'hôte peut faire ça.");
}
function requireLobby(room) {
  if (room.game && room.game.phase !== 'over') throw new UserError('La partie a déjà commencé.');
}

function startGame(room) {
  const n = room.members.length;
  if (n < 3) throw new UserError('Il faut au moins 3 joueurs (ajoute des bots).');
  if (n > MAX_PLAYERS) throw new UserError('6 joueurs maximum.');
  if (room.options.teams && n !== 4 && n !== 6) throw new UserError('Le mode équipes se joue à 4 ou 6 joueurs.');
  room.game = E.createGame({
    players: room.members.map((m) => ({ id: m.id, name: m.name, isBot: m.isBot, level: m.level })),
    mode: room.options.mode,
    teams: room.options.teams,
  });
  room.finishedAt = null;
}

function leave(room, m) {
  if (room.game && room.game.phase !== 'over') {
    // En pleine partie, le joueur est remplacé par un bot
    m.isBot = true;
    m.level = 'normal';
    m.sockets.clear();
    const gp = E.playerById(room.game, m.id);
    if (gp) { gp.isBot = true; gp.name = m.name; }
    room.game.log.push(`${m.name} a quitté la partie, un bot prend sa place.`);
  } else {
    room.members = room.members.filter((x) => x !== m);
    if (room.game) room.game = null; // partie finie : retour au salon
  }
  if (!humans(room).length) {
    deleteRoom(room);
    return;
  }
  if (room.hostId === m.id) room.hostId = humans(room)[0].id;
  broadcast(room);
}

function deleteRoom(room) {
  clearTimeout(room.timer);
  clearTimeout(room.afkTimer);
  rooms.delete(room.code);
}

function handle(ws, msg) {
  const ctx = ws.ctx;
  switch (msg.t) {
    case 'create': {
      detach(ws);
      const { room, member } = createRoom(msg.name);
      attach(ws, room, member);
      log(`salon ${room.code} créé`);
      return broadcast(room);
    }
    case 'join': {
      const code = String(msg.code || '').trim();
      const room = rooms.get(code);
      if (!room) throw new UserError(`Aucune partie avec le code ${code}.`);
      const name = cleanName(msg.name) || 'Joueur';
      // Même nom qu'un joueur déconnecté : on reprend sa place
      const ghost = room.members.find((m) => !m.isBot && m.sockets.size === 0 && m.name.toLowerCase() === name.toLowerCase());
      if (ghost) {
        detach(ws);
        attach(ws, room, ghost);
        return broadcast(room);
      }
      requireLobby(room);
      if (room.members.length >= MAX_PLAYERS) throw new UserError('La partie est complète (6 joueurs).');
      detach(ws);
      const m = addHuman(room, name);
      if (room.game) room.game = null;
      attach(ws, room, m);
      return broadcast(room);
    }
    case 'resume': {
      const room = rooms.get(String(msg.code || ''));
      const m = room && room.members.find((x) => x.id === msg.playerId && x.secret && x.secret === msg.secret);
      if (!m) return send(ws, { t: 'gone' });
      detach(ws);
      attach(ws, room, m);
      return broadcast(room);
    }
  }

  if (!ctx) throw new UserError("Tu n'es dans aucune partie.");
  const { room, member: m } = ctx;
  if (!rooms.has(room.code)) throw new UserError("Cette partie n'existe plus.");

  switch (msg.t) {
    case 'leave':
      detach(ws, true);
      leave(room, m);
      return send(ws, { t: 'left' });
    case 'addBot':
      requireHost(room, m); requireLobby(room);
      if (room.members.length >= MAX_PLAYERS) throw new UserError('6 joueurs maximum.');
      room.game = null;
      addBot(room, msg.level);
      return broadcast(room);
    case 'removeMember': {
      requireHost(room, m); requireLobby(room);
      const target = room.members.find((x) => x.id === msg.id);
      if (!target || target === m) return;
      room.members = room.members.filter((x) => x !== target);
      for (const s of target.sockets) { s.ctx = null; send(s, { t: 'kicked' }); }
      room.game = null;
      return broadcast(room);
    }
    case 'botLevel': {
      requireHost(room, m); requireLobby(room);
      const target = room.members.find((x) => x.id === msg.id && x.isBot);
      if (target && LEVEL_LABEL[msg.level]) target.level = msg.level;
      return broadcast(room);
    }
    case 'options':
      requireHost(room, m); requireLobby(room);
      if (msg.mode === 'simple' || msg.mode === 'spicy') room.options.mode = msg.mode;
      if (typeof msg.teams === 'boolean') room.options.teams = msg.teams;
      return broadcast(room);
    case 'seat': {
      // Déplacer un joueur d'un siège (utile pour composer les équipes)
      requireHost(room, m); requireLobby(room);
      const i = room.members.findIndex((x) => x.id === msg.id);
      const j = i + (msg.dir === 'up' ? -1 : 1);
      if (i < 0 || j < 0 || j >= room.members.length) return;
      [room.members[i], room.members[j]] = [room.members[j], room.members[i]];
      return broadcast(room);
    }
    case 'shuffleSeats':
      requireHost(room, m); requireLobby(room);
      E.shuffle(room.members);
      return broadcast(room);
    case 'start':
      requireHost(room, m); requireLobby(room);
      startGame(room);
      log(`salon ${room.code} : partie lancée (${room.members.length} joueurs, ${room.options.mode}${room.options.teams ? ', équipes' : ''})`);
      return broadcast(room);
    case 'backToLobby':
      requireHost(room, m);
      if (room.game && room.game.phase !== 'over') throw new UserError('La partie est en cours.');
      room.game = null;
      return broadcast(room);
    case 'reveal':
      if (!room.game) throw new UserError('Aucune partie en cours.');
      E.reveal(room.game, m.id, msg.src);
      return afterGameChange(room);
    case 'swap':
      if (!room.game) throw new UserError('Aucune partie en cours.');
      E.chooseSwap(room.game, m.id, msg.index);
      return afterGameChange(room);
    default:
      throw new UserError('Action inconnue.');
  }
}

function attach(ws, room, m) {
  ws.ctx = { room, member: m };
  m.sockets.add(ws);
  m.disconnectedAt = null;
  send(ws, { t: 'welcome', code: room.code, playerId: m.id, secret: m.secret, name: m.name });
}

function detach(ws, silent) {
  const ctx = ws.ctx;
  if (!ctx) return;
  ws.ctx = null;
  ctx.member.sockets.delete(ws);
  if (ctx.member.sockets.size === 0 && !ctx.member.isBot) {
    ctx.member.disconnectedAt = Date.now();
    if (!silent && rooms.has(ctx.room.code)) broadcast(ctx.room);
  }
}

// ── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'ping') return send(ws, { t: 'pong' });
    try {
      handle(ws, msg);
    } catch (err) {
      if (err instanceof UserError || err instanceof E.RuleError) send(ws, { t: 'error', message: err.message });
      else { log('erreur', err); send(ws, { t: 'error', message: 'Erreur du serveur.' }); }
    }
  });
  ws.on('close', () => detach(ws));
});

// Ping toutes les 25 s pour garder la connexion (et détecter les clients partis)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000).unref();

// Nettoyage : partie finie depuis 30 min, ou aucun humain connecté depuis 2 h
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyone = humans(room).some((m) => m.sockets.size > 0);
    if ((room.finishedAt && now - room.finishedAt > 30 * 60e3 && !anyone) || (!anyone && now - room.lastActivity > 2 * 3600e3)) {
      log(`salon ${room.code} supprimé`);
      deleteRoom(room);
    }
  }
}, 5 * 60e3).unref();

server.listen(PORT, () => log(`Trio sur le port ${PORT}`));

module.exports = { server, rooms, DELAY };
