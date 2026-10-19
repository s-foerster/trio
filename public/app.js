/* Trio — client (aucune dépendance). Chemins relatifs : marche à la racine comme sous /trio/. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('trio:' + k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('trio:' + k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem('trio:' + k); } catch {} },
  };

  const TEAM = [
    { name: 'Bleus', color: '#3d7bff' },
    { name: 'Orange', color: '#ff8a3d' },
    { name: 'Verts', color: '#2fbf71' },
  ];
  const LEVEL = { facile: 'facile', normal: 'normal', expert: 'expert' };

  // ── Cartes ────────────────────────────────────────────────────────────────
  // Visuels maison. Pour utiliser tes propres images, dépose public/cards/1.png … 12.png
  // (et back.png pour le dos) : elles seront utilisées automatiquement.
  const COLORS = {
    1: '#e5484d', 2: '#f2803a', 3: '#f2b705', 4: '#86b931', 5: '#2fa868', 6: '#14a3a0',
    7: '#7b3fe4', 8: '#2f7fe0', 9: '#4657c9', 10: '#b546c9', 11: '#e0508f', 12: '#8a6248',
  };
  let customFaces = false;
  let customBack = false;
  fetch('cards/manifest.json').then((r) => r.json()).then((m) => {
    customFaces = !!m.faces;
    customBack = !!m.back;
    if ((customFaces || customBack) && lastRoom) render(lastRoom);
  }).catch(() => {});

  function linksOf(v) {
    return [7 - v, v - 7, v + 7].filter((x) => x >= 1 && x <= 12 && x !== 7 && x !== v).sort((a, b) => a - b);
  }

  function pips(v) {
    let out = '';
    for (let i = 0; i < v; i++) {
      const a = (i / v) * Math.PI * 2 - Math.PI / 2;
      out += `<circle cx="${(50 + Math.cos(a) * 38).toFixed(1)}" cy="${(50 + Math.sin(a) * 38).toFixed(1)}" r="${v > 9 ? 5 : 6}"/>`;
    }
    return `<svg class="pips" viewBox="0 0 100 100" aria-hidden="true">${out}</svg>`;
  }

  function face(v, { spicy = false, size = '', extra = '' } = {}) {
    if (customFaces) {
      return `<div class="card face img ${size} ${extra}" data-v="${v}"><img src="cards/${v}.png" alt="${v}" draggable="false"></div>`;
    }
    const links = spicy ? `<div class="links">${linksOf(v).map((l) => `<b>${l}</b>`).join('')}</div>` : '';
    return `<div class="card face ${size} ${extra} ${v === 7 ? 'seven' : ''}" data-v="${v}" style="--c:${COLORS[v]}">
      <span class="corner tl">${v}</span><span class="corner br">${v}</span>
      <div class="center">${pips(v)}<span class="num">${v}</span></div>${links}</div>`;
  }

  function back({ size = '', extra = '', attrs = '' } = {}) {
    if (customBack) return `<div class="card back img ${size} ${extra}" ${attrs}><img src="cards/back.png" alt="" draggable="false"></div>`;
    return `<div class="card back ${size} ${extra}" ${attrs}><div class="back-logo"><i></i><i></i><i></i></div></div>`;
  }

  // ── Connexion ─────────────────────────────────────────────────────────────
  const WS_URL = new URL('ws', location.href).href.replace(/^http/, 'ws');
  let ws = null;
  let retry = 0;
  let queue = [];
  let lastRoom = null;
  let session = store.get('session'); // { code, playerId, secret }

  function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      retry = 0;
      $('#offline').classList.add('hidden');
      if (session) ws.send(JSON.stringify({ t: 'resume', ...session }));
      queue.forEach((m) => ws.send(JSON.stringify(m)));
      queue = [];
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      onMessage(msg);
    };
    ws.onclose = () => {
      if (session) $('#offline').classList.remove('hidden');
      const delay = Math.min(8000, 500 * 2 ** retry++);
      setTimeout(connect, delay);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    else queue.push(msg);
  }

  // Garde la connexion active derrière les proxys
  setInterval(() => { if (ws && ws.readyState === 1) ws.send('{"t":"ping"}'); }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ws && ws.readyState > 1) { retry = 0; }
  });

  function onMessage(msg) {
    switch (msg.t) {
      case 'welcome':
        session = { code: msg.code, playerId: msg.playerId, secret: msg.secret };
        store.set('session', session);
        history.replaceState(null, '', '?code=' + msg.code);
        break;
      case 'state':
        render(msg.room);
        break;
      case 'error':
        toast(msg.message);
        break;
      case 'gone':
      case 'left':
      case 'kicked':
        if (msg.t === 'kicked') toast("L'hôte t'a retiré de la partie.");
        if (msg.t === 'gone' && session) toast("Cette partie n'existe plus.");
        session = null;
        store.del('session');
        lastRoom = null;
        history.replaceState(null, '', location.pathname);
        show('home');
        break;
    }
  }

  // ── Écrans ───────────────────────────────────────────────────────────────
  function show(id) {
    for (const s of ['home', 'lobby', 'game']) $('#' + s).classList.toggle('hidden', s !== id);
    if (id !== 'game') $('#endModal').classList.add('hidden');
  }

  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
  }

  // Accueil
  $('#nameInput').value = store.get('name') || '';
  const urlCode = new URLSearchParams(location.search).get('code');
  if (urlCode) $('#codeInput').value = urlCode;

  const myName = () => {
    const n = $('#nameInput').value.trim();
    store.set('name', n);
    return n;
  };
  $('#createBtn').onclick = () => {
    if (!myName()) { $('#nameInput').focus(); return toast('Choisis un pseudo.'); }
    send({ t: 'create', name: myName() });
  };
  $('#joinBtn').onclick = () => {
    const code = $('#codeInput').value.trim();
    if (!myName()) { $('#nameInput').focus(); return toast('Choisis un pseudo.'); }
    if (!/^\d{4}$/.test(code)) return toast('Le code fait 4 chiffres.');
    send({ t: 'join', code, name: myName() });
  };
  $('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });
  $('#nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('#codeInput').value ? $('#joinBtn') : $('#createBtn')).click(); });

  // Règles
  $$('.rules-open').forEach((b) => (b.onclick = () => $('#rulesModal').classList.remove('hidden')));
  $$('.rules-close').forEach((b) => (b.onclick = () => $('#rulesModal').classList.add('hidden')));
  $$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m && m.id === 'rulesModal') m.classList.add('hidden'); }));

  // Salon
  const quit = () => { if (confirmQuit()) send({ t: 'leave' }); };
  function confirmQuit() {
    const g = lastRoom && lastRoom.game;
    if (g && g.phase !== 'over') return window.confirm('Quitter la partie ? Un bot prendra ta place.');
    return true;
  }
  $('#lobbyQuit').onclick = quit;
  $('#gameQuit').onclick = quit;
  $('#copyLink').onclick = async () => {
    const link = new URL('.', location.href).href + '?code=' + lastRoom.code;
    try { await navigator.clipboard.writeText(link); toast('Lien copié !'); } catch { toast(link); }
  };
  $('#addBotBtn').onclick = () => send({ t: 'addBot', level: $('#botLevel').value });
  $$('#modeSeg button').forEach((b) => (b.onclick = () => send({ t: 'options', mode: b.dataset.mode })));
  $('#teamsToggle').onchange = (e) => send({ t: 'options', teams: e.target.checked });
  $('#shuffleBtn').onclick = () => send({ t: 'shuffleSeats' });
  $('#startBtn').onclick = () => send({ t: 'start' });
  $('#memberList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'remove') send({ t: 'removeMember', id: b.dataset.id });
    if (b.dataset.act === 'up' || b.dataset.act === 'down') send({ t: 'seat', id: b.dataset.id, dir: b.dataset.act });
  });
  $('#memberList').addEventListener('change', (e) => {
    const s = e.target.closest('select[data-id]');
    if (s) send({ t: 'botLevel', id: s.dataset.id, level: s.value });
  });

  // Fin de partie
  $('#replayBtn').onclick = () => send({ t: 'start' });
  $('#lobbyBtn').onclick = () => send({ t: 'backToLobby' });
  $('#endClose').onclick = () => { $('#endModal').classList.add('hidden'); endDismissed = true; };
  let endDismissed = false;

  // ── Rendu ────────────────────────────────────────────────────────────────
  function render(room) {
    const prev = lastRoom;
    lastRoom = room;
    if (!room.game) {
      endDismissed = false;
      renderLobby(room);
      return show('lobby');
    }
    show('game');
    renderGame(room, prev);
  }

  function renderLobby(room) {
    const isHost = room.hostId === room.you;
    const n = room.members.length;
    const teams = room.options.teams;
    const nTeams = teams && (n === 4 || n === 6) ? n / 2 : 0;
    $('#lobbyCode').textContent = room.code;
    $('#playerCount').textContent = `(${n}/6)`;
    $('#memberList').innerHTML = room.members.map((m, i) => {
      const team = nTeams ? TEAM[i % nTeams] : null;
      const badges = [
        m.id === room.hostId ? '<span class="badge">Hôte</span>' : '',
        m.id === room.you ? '<span class="badge you">Toi</span>' : '',
        !m.connected ? '<span class="badge off">Absent</span>' : '',
      ].join('');
      const level = m.isBot
        ? isHost
          ? `<select data-id="${m.id}" aria-label="Niveau">${Object.keys(LEVEL).map((l) => `<option value="${l}" ${l === m.level ? 'selected' : ''}>${LEVEL[l]}</option>`).join('')}</select>`
          : `<span class="badge bot">Bot ${LEVEL[m.level] || ''}</span>`
        : '';
      const ctrls = isHost
        ? `<div class="ctrls">
            <button class="icon" data-act="up" data-id="${m.id}" ${i === 0 ? 'disabled' : ''} aria-label="Monter">↑</button>
            <button class="icon" data-act="down" data-id="${m.id}" ${i === n - 1 ? 'disabled' : ''} aria-label="Descendre">↓</button>
            ${m.id !== room.you ? `<button class="icon danger" data-act="remove" data-id="${m.id}" aria-label="Retirer">✕</button>` : ''}
          </div>`
        : '';
      return `<li>
        <span class="seat" style="${team ? `background:${team.color}` : ''}">${i + 1}</span>
        <span class="mname">${m.isBot ? '🤖 ' : ''}${esc(m.name)}</span>${badges}${level}${ctrls}
      </li>`;
    }).join('');

    $('#botAdd').classList.toggle('hidden', !isHost || n >= 6);
    $$('#modeSeg button').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === room.options.mode);
      b.disabled = !isHost;
    });
    $('#modeHint').textContent = room.options.mode === 'spicy'
      ? 'Piquant : 2 trios liés (somme ou différence = 7) ou le trio de 7.'
      : 'Simple : 3 trios ou le trio de 7.';
    $('#teamsToggle').checked = teams;
    $('#teamsToggle').disabled = !isHost;
    $('#shuffleBtn').classList.toggle('hidden', !isHost);

    let problem = '';
    if (n < 3) problem = `Il faut au moins 3 joueurs : ajoute ${3 - n} bot${3 - n > 1 ? 's' : ''} ou invite des amis.`;
    else if (teams && n !== 4 && n !== 6) problem = 'Le mode équipes se joue à 4 ou 6 joueurs.';
    else if (teams) problem = 'Les partenaires ont la même couleur et jouent face à face.';
    $('#startBtn').classList.toggle('hidden', !isHost);
    $('#startBtn').disabled = n < 3 || (teams && n !== 4 && n !== 6);
    $('#lobbyWait').textContent = isHost ? problem : "En attente du lancement par l'hôte…";
  }

  function nameOf(g, id) {
    const p = g.players.find((x) => x.id === id);
    return p ? p.name : '?';
  }

  function srcLabel(g, src, you) {
    if (src.type === 'middle') return 'Milieu';
    const who = src.target === you ? 'Toi' : nameOf(g, src.target);
    return `${who} ${src.end === 'low' ? '▼ min' : '▲ max'}`;
  }

  function renderGame(room, prev) {
    const g = room.game;
    const you = room.you;
    const me = g.players.find((p) => p.id === you);
    const spicy = g.mode === 'spicy';
    const myTurn = g.phase === 'play' && g.currentId === you;
    const teamOf = (p) => (g.teams && p.team !== null ? TEAM[p.team] : null);

    $('#gameCode').textContent = room.code;
    $('#modeChip').textContent = (spicy ? 'Piquant' : 'Simple') + (g.teams ? ' · équipes' : '');

    // Statut
    let status = '';
    let cls = '';
    const cur = g.players.find((p) => p.id === g.currentId);
    if (g.phase === 'over') {
      status = g.winner ? g.winner.text : 'Partie terminée';
      cls = g.winner && g.winner.ids.includes(you) ? 'win' : '';
    } else if (g.phase === 'swap') {
      status = g.swap.mustPick
        ? 'Échange : touche la carte à donner à ton partenaire.'
        : g.swap.teams.includes(me && me.team) ? 'En attente de ton partenaire…' : 'Les autres équipes échangent une carte…';
      cls = g.swap.mustPick ? 'act' : '';
    } else if (g.phase === 'resolve') {
      status = g.resolve === 'trio' ? `Trio de ${g.revealed[0].v} pour ${cur.id === you ? 'toi' : cur.name} !` : 'Raté…';
      cls = g.resolve === 'trio' ? 'win' : 'fail';
    } else if (myTurn) {
      const r = g.revealed;
      status = !r.length
        ? 'À toi ! Révèle une carte : milieu, ou plus petite / plus grande d\'une main.'
        : r.length === 1 ? `Un ${r[0].v}… trouve un deuxième ${r[0].v} !` : `Deux ${r[0].v} ! Encore un pour le trio.`;
      cls = 'act';
    } else {
      status = `Au tour de ${cur.name}${cur.isBot ? ' 🤖' : ''}`;
    }
    const st = $('#status');
    st.textContent = status;
    st.className = 'status ' + cls;

    // Adversaires (dans l'ordre du tour, en commençant après moi)
    const idx = g.players.findIndex((p) => p.id === you);
    const order = g.players.map((_, i) => g.players[(idx + 1 + i) % g.players.length]).filter((p) => p.id !== you);
    const member = (id) => room.members.find((m) => m.id === id);
    $('#opponents').innerHTML = order.map((p) => {
      const t = teamOf(p);
      const mem = member(p.id);
      const off = mem && !mem.connected;
      const isCur = p.id === g.currentId && g.phase !== 'over';
      const canAsk = myTurn && p.handCount > 0;
      const fan = p.hand
        ? p.hand.map((v) => face(v, { size: 'xs', spicy })).join('')
        : Array.from({ length: Math.min(p.handCount, 12) }, () => back({ size: 'xs' })).join('');
      return `<div class="opp ${isCur ? 'current' : ''} ${off ? 'off' : ''}" style="${t ? `--team:${t.color}` : ''}">
        <div class="opp-head">
          ${t ? '<span class="team-dot"></span>' : ''}
          <span class="opp-name">${p.isBot ? '🤖 ' : ''}${esc(p.name)}</span>
          <span class="count" title="Cartes en main">${p.handCount}</span>
        </div>
        <div class="fan">${fan || '<span class="muted small">plus de carte</span>'}</div>
        <div class="ask">
          <button class="btn small" data-ask="low" data-id="${p.id}" title="Révéler sa plus petite carte" ${canAsk ? '' : 'disabled'}>▼ Min</button>
          <button class="btn small" data-ask="high" data-id="${p.id}" title="Révéler sa plus grande carte" ${canAsk ? '' : 'disabled'}>▲ Max</button>
        </div>
        <div class="trios">${p.trios.map((v) => face(v, { size: 'mini', spicy })).join('')}</div>
      </div>`;
    }).join('');

    // Cartes révélées
    const prevCount = prev && prev.game && prev.game.turnNo === g.turnNo ? prev.game.revealed.length : 0;
    $('#revealed').innerHTML = g.revealed.length
      ? g.revealed.map((r, i) => `<div class="rev ${i >= prevCount ? 'flip' : ''}">
          ${face(r.v, { spicy, size: 'lg', extra: g.resolve === 'fail' && r.v !== g.revealed[0].v ? 'wrong' : g.resolve === 'trio' ? 'good' : '' })}
          <span class="rev-src">${esc(srcLabel(g, r.src, you))}</span></div>`).join('')
        + (g.phase === 'play' ? Array.from({ length: 3 - g.revealed.length }, () => '<div class="rev"><div class="card slot lg"></div></div>').join('') : '')
      : '<div class="rev-empty">Les cartes révélées apparaissent ici</div>';
    $('#revealed').className = 'revealed ' + (g.resolve || '');

    // Milieu
    const mid = g.middle;
    if (mid.length) {
      $('#middle').classList.remove('hidden');
      $('#middle').innerHTML = mid.map((c, i) => {
        if (c === null) return '<div class="card slot"></div>';
        if (c.up) return `<div class="card slot used"></div>`;
        return back({ extra: myTurn ? 'clickable' : '', attrs: `data-mid="${i}" ${myTurn ? 'role="button" tabindex="0" aria-label="Retourner cette carte"' : ''}` });
      }).join('');
    } else {
      $('#middle').classList.add('hidden');
      $('#middle').innerHTML = '';
    }

    // Ma main
    if (me) {
      const t = teamOf(me);
      const hand = me.hand || [];
      const swapMode = g.phase === 'swap' && g.swap.mustPick;
      const cards = hand.map((v, i) => {
        const end = i === 0 ? 'low' : i === hand.length - 1 ? 'high' : '';
        const playable = (myTurn && (i === 0 || i === hand.length - 1)) || swapMode;
        return `<div class="hand-card ${playable ? 'playable' : ''}" ${playable ? `data-hand="${i}" data-end="${end || (i === 0 ? 'low' : 'high')}" role="button" tabindex="0"` : ''}>${face(v, { spicy })}</div>`;
      }).join('');
      $('#me').innerHTML = `<div class="me-head ${g.currentId === you && g.phase !== 'over' ? 'current' : ''}" style="${t ? `--team:${t.color}` : ''}">
          ${t ? `<span class="team-dot"></span><span class="muted small">${t.name}</span>` : ''}
          <span class="opp-name">Ta main</span><span class="count">${hand.length}</span>
          <div class="trios">${me.trios.map((v) => face(v, { size: 'mini', spicy })).join('')}</div>
        </div>
        <div class="hand ${swapMode ? 'swap' : ''}">${cards || '<span class="muted">Tu n\'as plus de carte.</span>'}</div>
        ${myTurn && hand.length ? `<div class="ask mine">
          <button class="btn small" data-ask="low" data-id="${you}">▼ Ma plus petite</button>
          <button class="btn small" data-ask="high" data-id="${you}">▲ Ma plus grande</button></div>` : ''}`;
    }

    // Historique
    $('#logList').innerHTML = g.log.slice().reverse().map((l) => `<li>${esc(l)}</li>`).join('');

    // Fin
    if (g.phase === 'over' && !endDismissed) {
      const won = g.winner && g.winner.ids.includes(you);
      $('#endTitle').textContent = won ? 'Victoire !' : g.winner && g.winner.ids.length ? 'Perdu…' : 'Égalité';
      $('#endText').textContent = g.winner ? g.winner.text : '';
      $('#endHands').innerHTML = g.players.map((p) => `<div class="end-row"><span>${esc(p.name)}</span>
        <div class="trios">${p.trios.map((v) => face(v, { size: 'mini', spicy })).join('') || '<span class="muted small">aucun trio</span>'}</div></div>`).join('');
      const isHost = room.hostId === you;
      $('#replayBtn').classList.toggle('hidden', !isHost);
      $('#lobbyBtn').classList.toggle('hidden', !isHost);
      $('#endModal').classList.remove('hidden');
    } else if (g.phase !== 'over') {
      endDismissed = false;
      $('#endModal').classList.add('hidden');
    }
  }

  // ── Actions de jeu ───────────────────────────────────────────────────────
  function act(el) {
    const g = lastRoom && lastRoom.game;
    if (!g) return;
    if (el.dataset.mid !== undefined) return send({ t: 'reveal', src: { type: 'middle', index: Number(el.dataset.mid) } });
    if (el.dataset.ask) return send({ t: 'reveal', src: { type: 'hand', target: el.dataset.id, end: el.dataset.ask } });
    if (el.dataset.hand !== undefined) {
      if (g.phase === 'swap') return send({ t: 'swap', index: Number(el.dataset.hand) });
      return send({ t: 'reveal', src: { type: 'hand', target: lastRoom.you, end: el.dataset.end } });
    }
  }
  $('#game').addEventListener('click', (e) => {
    const el = e.target.closest('[data-mid],[data-ask],[data-hand]');
    if (el && !el.disabled) act(el);
  });
  $('#game').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('[data-mid],[data-hand]');
    if (el) { e.preventDefault(); act(el); }
  });

  connect();
})();
