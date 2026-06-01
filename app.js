const STORE_KEY = "quarta-fc-v1";
const TEAM_SIZE = 6;
const MATCH_SECONDS = 10 * 60;
const MAX_PLAYERS = 28;

const ui = {
  page: "home",
  modal: null,
  timerId: null,
};

let data = load();

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || { sessions: [], activeId: null };
  } catch {
    return { sessions: [], activeId: null };
  }
}

function save() {
  saveLocal();
  cloud.persist(active());
}

function saveLocal() {
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
}

function active() {
  return data.sessions.find((session) => session.id === data.activeId) || null;
}

function uid(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[char]));
}

function teamName(team) {
  return team ? `TIME ${team.label}` : "A definir";
}

function nextLabel(session) {
  const index = session.teamCounter++;
  let label = "";
  let value = index;
  while (value >= 0) {
    label = String.fromCharCode((value % 26) + 65) + label;
    value = Math.floor(value / 26) - 1;
  }
  return label;
}

function newTeam(session, players = []) {
  return { id: uid("team"), label: nextLabel(session), players };
}

function formatDate(date) {
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${date}T12:00:00`));
}

function formatTimer(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function createSession(name, date) {
  const session = {
    id: uid("session"),
    name: name || "Futebol de quarta",
    date,
    createdAt: new Date().toISOString(),
    teamCounter: 0,
    players: [],
    removed: [],
    waiting: [],
    current: null,
    games: [],
    events: [],
    generated: false,
  };
  data.sessions.unshift(session);
  data.activeId = session.id;
  save();
  ui.page = "list";
  render();
}

function addPlayer(name, saved = null) {
  const session = active();
  const cleanName = name.trim();
  if (!cloud.canEdit() || !session || !cleanName || activePlayerCount(session) >= MAX_PLAYERS) return;
  const player = { id: saved?.id || uid("player"), name: saved?.nickname || saved?.name || cleanName, fullName: saved?.name || cleanName, goals: 0, wins: 0 };
  session.players.push(player);
  if (session.generated) appendPlayers(session, [player]);
  save();
  render();
}

function addRegisteredPlayer(playerId) {
  const session = active();
  const saved = cloud.players.find((player) => player.id === playerId);
  if (!cloud.canEdit() || !session || !saved || activePlayerCount(session) >= MAX_PLAYERS) return;
  if (session.players.some((player) => player.id === saved.id)) return;
  const player = { id: saved.id, name: saved.nickname || saved.name, fullName: saved.name, goals: 0, wins: 0 };
  session.players.push(player);
  if (session.generated) appendPlayers(session, [player]);
  save();
  render();
}

function removeAttendance(playerId) {
  const session = active();
  if (!cloud.canEdit() || !session || session.generated) return;
  session.players = session.players.filter((player) => player.id !== playerId);
  save();
  render();
}

function activePlayerCount(session) {
  return session.players.length - session.removed.length;
}

function shuffle(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function generateTeams() {
  const session = active();
  if (!cloud.canEdit() || !session || session.players.length < 12) return;
  session.teamCounter = 0;
  session.waiting = [];
  const first = shuffle(session.players.slice(0, 12));
  const a = newTeam(session, first.slice(0, TEAM_SIZE));
  const b = newTeam(session, first.slice(TEAM_SIZE, TEAM_SIZE * 2));
  for (let index = 12; index < session.players.length; index += TEAM_SIZE) {
    session.waiting.push(newTeam(session, session.players.slice(index, index + TEAM_SIZE)));
  }
  session.current = makeGame(a, b);
  session.generated = true;
  session.events.push({ type: "info", text: "Times iniciais gerados", at: new Date().toISOString() });
  save();
  ui.page = "teams";
  render();
}

function makeGame(home, away) {
  return {
    id: uid("game"),
    home,
    away,
    homeScore: 0,
    awayScore: 0,
    seconds: MATCH_SECONDS,
    running: false,
    goals: [],
    startedAt: null,
  };
}

function appendPlayers(session, players) {
  let remaining = [...players];
  const tail = session.waiting[session.waiting.length - 1];
  if (tail && tail.players.length < TEAM_SIZE) {
    const amount = Math.min(TEAM_SIZE - tail.players.length, remaining.length);
    tail.players.push(...remaining.splice(0, amount));
  }
  while (remaining.length) {
    session.waiting.push(newTeam(session, remaining.splice(0, TEAM_SIZE)));
  }
}

function shiftComplete(session) {
  const index = session.waiting.findIndex((team) => team.players.length === TEAM_SIZE);
  if (index < 0) return null;
  return session.waiting.splice(index, 1)[0];
}

function removeEmptyWaiting(session) {
  session.waiting = session.waiting.filter((team) => team.players.length);
}

function findPlayerLocation(session, playerId) {
  if (session.current) {
    for (const side of ["home", "away"]) {
      const index = session.current[side].players.findIndex((player) => player.id === playerId);
      if (index >= 0) return { kind: "current", team: session.current[side], index };
    }
  }
  for (const team of session.waiting) {
    const index = team.players.findIndex((player) => player.id === playerId);
    if (index >= 0) return { kind: "waiting", team, index };
  }
  return null;
}

function removePlayer(playerId) {
  const session = active();
  if (!cloud.canEdit()) return;
  const location = session && findPlayerLocation(session, playerId);
  if (!location) return;
  const [player] = location.team.players.splice(location.index, 1);
  let replacement = null;
  const lastTeam = session.waiting[session.waiting.length - 1];
  if (location.kind === "current" && lastTeam?.players.length) {
    replacement = lastTeam.players.pop();
    location.team.players.splice(location.index, 0, replacement);
  }
  session.removed.push({ ...player, removedAt: new Date().toISOString() });
  session.events.push({
    type: "exit",
    text: `${player.name} saiu${replacement ? ` e ${replacement.name} ocupou a vaga` : ""}`,
    at: new Date().toISOString(),
  });
  removeEmptyWaiting(session);
  save();
  render();
}

function restorePlayer(playerId) {
  const session = active();
  if (!cloud.canEdit() || !session || activePlayerCount(session) >= MAX_PLAYERS) return;
  const index = session.removed.findIndex((player) => player.id === playerId);
  if (index < 0) return;
  const [removed] = session.removed.splice(index, 1);
  const player = session.players.find((item) => item.id === removed.id) || {
    id: removed.id, name: removed.name, goals: removed.goals, wins: removed.wins,
  };
  appendPlayers(session, [player]);
  session.events.push({ type: "return", text: `${player.name} voltou ao fim da fila`, at: new Date().toISOString() });
  save();
  render();
}

function startTimer() {
  const game = active()?.current;
  if (!cloud.canEdit() || !game || game.running) return;
  game.running = true;
  game.startedAt ||= new Date().toISOString();
  ui.timerId = setInterval(() => {
    const current = active()?.current;
    if (!current?.running) return stopTimer();
    if (current.seconds > 0) current.seconds -= 1;
    if (current.seconds <= 0) current.running = false;
    save();
    render();
  }, 1000);
  save();
  render();
}

function stopTimer() {
  if (!cloud.canEdit()) return;
  if (ui.timerId) clearInterval(ui.timerId);
  ui.timerId = null;
  const game = active()?.current;
  if (game) game.running = false;
  save();
  render();
}

function resetTimer() {
  if (!cloud.canEdit()) return;
  stopTimer();
  const game = active()?.current;
  if (!game) return;
  game.seconds = MATCH_SECONDS;
  save();
  render();
}

function addGoal(side, playerId) {
  if (!cloud.canEdit()) return;
  const session = active();
  const game = session?.current;
  const team = game?.[side];
  const player = team?.players.find((item) => item.id === playerId);
  if (!player) return;
  game[`${side}Score`] += 1;
  game.goals.push({ id: uid("goal"), playerId, playerName: player.name, teamLabel: team.label, minute: Math.ceil((MATCH_SECONDS - game.seconds) / 60) || 1 });
  player.goals += 1;
  save();
  ui.modal = null;
  render();
}

function removeGoal(side, playerId) {
  if (!cloud.canEdit()) return;
  const session = active();
  const game = session?.current;
  const team = game?.[side];
  const player = team?.players.find((item) => item.id === playerId);
  if (!player) return;
  const index = game.goals.findLastIndex((goal) => goal.playerId === playerId);
  if (index < 0) return;
  game.goals.splice(index, 1);
  game[`${side}Score`] = Math.max(0, game[`${side}Score`] - 1);
  player.goals = Math.max(0, player.goals - 1);
  save();
  render();
}

function matchGoals(game, playerId) {
  return game.goals.filter((goal) => goal.playerId === playerId).length;
}

function finishGame(mode, preferredSide = null) {
  if (!cloud.canEdit()) return;
  stopTimer();
  const session = active();
  const game = session?.current;
  if (!game) return;
  const copy = { ...game, running: false, finishedAt: new Date().toISOString() };
  session.games.push(copy);

  if (mode === "draw-exit") {
    const ordered = preferredSide === "away" ? [game.away, game.home] : [game.home, game.away];
    ordered.forEach((team) => appendPlayers(session, team.players));
    const first = shiftComplete(session);
    const second = shiftComplete(session);
    session.current = first && second ? makeGame(first, second) : null;
  } else {
    let winner = game.home;
    let loser = game.away;
    if (preferredSide === "away" || (!preferredSide && game.awayScore > game.homeScore)) {
      winner = game.away;
      loser = game.home;
    }
    winner.players.forEach((player) => player.wins += 1);
    appendPlayers(session, loser.players);
    const next = shiftComplete(session);
    session.current = next ? makeGame(winner, next) : null;
  }
  session.events.push({ type: "match", text: `${teamName(game.home)} ${game.homeScore} x ${game.awayScore} ${teamName(game.away)}`, at: new Date().toISOString() });
  ui.modal = null;
  save();
  render();
}

function currentPlayerIds(session) {
  return new Set([...(session.current?.home.players || []), ...(session.current?.away.players || [])].map((p) => p.id));
}

function allActiveTeams(session) {
  return [...(session.current ? [session.current.home, session.current.away] : []), ...session.waiting];
}

function renderTeam(team, options = {}) {
  const { current = false, removable = false } = options;
  if (!team) return "";
  return `
    <article class="card team-card ${current ? "current" : ""} ${team.players.length < TEAM_SIZE ? "incomplete" : ""}">
      <div class="team-head">
        <span class="team-label">${teamName(team)}</span>
        <span class="badge ${team.players.length < TEAM_SIZE ? "wait" : ""}">${team.players.length}/${TEAM_SIZE}</span>
      </div>
      <div class="team-list">
        ${team.players.map((player, index) => `
          <div class="player">
            <span class="number">${index + 1}</span>
            <span class="player-name">${esc(player.name)}</span>
            ${removable ? `<button class="icon-btn" data-action="remove-player" data-player="${player.id}" aria-label="Remover ${esc(player.name)}">×</button>` : ""}
          </div>
        `).join("") || `<div class="empty">Sem jogadores</div>`}
      </div>
    </article>`;
}

function renderHome() {
  const sessions = data.sessions;
  return `
    <main class="page">
      <section class="card hero">
        <span class="badge live"><span class="dot"></span> quarta-feira</span>
        <h2>Sua pelada organizada do início ao fim.</h2>
        <p>Cadastre a lista, acompanhe a fila e deixe a subida dos times acontecer sem confusão.</p>
        <button class="btn primary full" style="margin-top:16px" data-action="open-create">+ Criar nova pelada</button>
      </section>
      <section class="card">
        <div class="section-head"><h2>Histórico de peladas</h2><span class="badge">${sessions.length}</span></div>
        <div class="stack">
          ${sessions.map((session) => `
            <button class="btn full split" data-action="open-session" data-session="${session.id}">
              <span style="text-align:left">${esc(session.name)}<br><small class="muted">${formatDate(session.date)} · ${session.players.length} jogadores</small></span>
              <span>›</span>
            </button>
          `).join("") || `<div class="empty">Nenhuma pelada criada ainda.<br>Crie a primeira para começar.</div>`}
        </div>
      </section>
    </main>`;
}

function renderSetup() {
  return `<main class="page"><section class="card hero"><p class="eyebrow">Configuracao necessaria</p><h2>Conecte o banco de dados</h2><p>Preencha o arquivo <strong>config.js</strong> com a URL e a chave publica do seu projeto Supabase.</p></section><section class="card"><h2>Proximo passo</h2><p class="muted small" style="margin-top:8px;line-height:1.6">Execute o arquivo <strong>supabase-schema.sql</strong> no SQL Editor do Supabase e publique novamente os arquivos do site.</p></section></main>`;
}

function renderAccess() {
  return `<main class="page auth-page">
    <section class="card hero"><p class="eyebrow">Quarta FC</p><h2>Organize a pelada sem deixar o celular preso na lateral.</h2><p>Entre como administrador ou use um codigo para acompanhar e ajudar durante os jogos.</p></section>
    ${cloud.notice ? `<p class="notice">${esc(cloud.notice)}</p>` : ""}
    <section class="card"><div class="section-head"><h2>Entrar</h2></div><form class="grid" data-form="login"><input class="input" name="email" type="email" placeholder="Seu e-mail" required /><input class="input" name="password" type="password" placeholder="Sua senha" required /><button class="btn primary full">Entrar</button></form></section>
    <section class="card"><details><summary class="details-title">Criar cadastro</summary><form class="grid details-form" data-form="signup"><input class="input" name="email" type="email" placeholder="Seu e-mail" required /><input class="input" name="password" type="password" minlength="6" placeholder="Crie uma senha" required /><button class="btn full">Cadastrar</button></form></details></section>
    <section class="card"><div class="section-head"><div><p class="eyebrow">Acesso rapido</p><h2>Entrar com codigo</h2></div></div><form class="add-form" data-form="access-code"><input class="input code-input" name="code" maxlength="8" placeholder="CODIGO" required /><button class="btn primary">Acessar</button></form></section>
  </main>`;
}

function renderClubs() {
  return `<main class="page">
    <section class="card hero"><p class="eyebrow">Minhas peladas</p><h2>Escolha sua pelada fixa.</h2><p>Crie quantas peladas quiser. Cada uma possui elenco, rodadas e estatisticas proprias.</p><button class="btn primary full" style="margin-top:16px" data-action="open-create-club">+ Criar pelada fixa</button></section>
    ${cloud.notice ? `<p class="notice">${esc(cloud.notice)}</p>` : ""}
    <section class="card"><div class="section-head"><h2>Peladas</h2><span class="badge">${cloud.clubs.length}</span></div><div class="stack">
      ${cloud.clubs.map((club) => `<button class="btn full split" data-action="open-club" data-club="${club.id}"><span><strong>${esc(club.initials)}</strong> · ${esc(club.name)}</span><span>›</span></button>`).join("") || `<div class="empty">Crie sua primeira pelada fixa.</div>`}
    </div></section>
    <button class="btn full" data-action="logout">Sair da conta</button>
  </main>`;
}

function roundDefaultName() {
  const date = new Date();
  const label = date.toLocaleDateString("pt-BR");
  return `Quarta ${label}`;
}

function renderClubDashboard() {
  const general = cloud.totals;
  return `<main class="page">
    <section class="card hero"><p class="eyebrow">${esc(cloud.club.initials)} · pelada fixa</p><h2>${esc(cloud.club.name)}</h2><p>${cloud.mode === "view" ? "Acesso somente para visualizacao." : cloud.mode === "edit" ? "Acesso operacional por codigo." : "Painel do administrador."}</p>
      ${cloud.canEdit() ? `<button class="btn primary full" style="margin-top:16px" data-action="open-create-round">+ Nova rodada</button>` : ""}
    </section>
    ${cloud.notice ? `<p class="notice">${esc(cloud.notice)}</p>` : ""}
    ${cloud.isOwner() ? `<section class="card"><div class="section-head"><div><p class="eyebrow">Compartilhar</p><h2>Codigo de visualizacao</h2></div><span class="access-code">${esc(cloud.club.view_code || "Disponivel na criacao")}</span></div><p class="muted small">Este codigo e fixo. Quem usar pode acompanhar a pelada sem alterar dados.</p></section>` : ""}
    <div class="dashboard-grid">
      <button class="card dashboard-card" data-action="club-section" data-section="roster"><span class="stat-value">${cloud.players.length}</span><span class="stat-label">Jogadores cadastrados</span><small>Ver elenco completo ›</small></button>
      <button class="card dashboard-card" data-action="club-section" data-section="rounds"><span class="stat-value">${cloud.rounds.length}</span><span class="stat-label">Saves anteriores</span><small>Ver rodadas ›</small></button>
      <button class="card dashboard-card wide" data-action="club-section" data-section="general-stats"><span class="stat-value">${general.reduce((sum, player) => sum + Number(player.goals || 0), 0)}</span><span class="stat-label">Gols acumulados</span><small>Ver estatisticas gerais ›</small></button>
    </div>
    <section class="card"><div class="section-head"><div><p class="eyebrow">Ultimos saves</p><h2>Rodadas recentes</h2></div><button class="btn small-btn" data-action="club-section" data-section="rounds">Ver todos</button></div>
      ${cloud.rounds.slice(0, 3).map((round) => `<button class="btn full split" data-action="open-round" data-round="${round.id}"><span style="text-align:left">${esc(round.name)}<br><small class="muted">${formatDate(round.round_date)}</small></span><span>›</span></button>`).join("") || `<div class="empty">Nenhuma rodada criada ainda.</div>`}
    </section>
    ${cloud.isOwner() ? `<button class="btn full" data-action="rotate-edit-code">Gerar novo codigo de edicao</button>` : ""}
    <button class="btn full" data-action="close-club">Voltar</button>
  </main>`;
}

function clubSectionHead(eyebrow, title) {
  return `<section class="section-page-head"><button class="btn small-btn" data-action="club-section" data-section="dashboard">‹ Voltar</button><div><p class="eyebrow">${eyebrow}</p><h2>${title}</h2></div></section>`;
}

function renderClubRoster() {
  return `<main class="page">${clubSectionHead("Elenco fixo", "Jogadores cadastrados")}
    <section class="card"><div class="section-head"><span class="badge">${cloud.players.length} jogadores</span>${cloud.isOwner() ? `<button class="btn primary small-btn" data-action="open-add-roster">+ Jogador</button>` : ""}</div>
    ${cloud.players.map((player) => `<div class="player"><span class="number">${esc(player.initials)}</span><span class="player-name">${esc(player.nickname || player.name)}<br><small class="muted">${esc(player.name)}</small></span>${cloud.isOwner() ? `<button class="icon-btn" data-action="confirm-remove-roster" data-player="${player.id}" aria-label="Remover ${esc(player.name)}">×</button>` : ""}</div>`).join("") || `<div class="empty">Cadastre os jogadores uma vez e selecione os presentes em cada rodada.</div>`}
    </section></main>`;
}

function renderClubRounds() {
  return `<main class="page">${clubSectionHead("Historico", "Saves anteriores")}
    <section class="card"><div class="section-head"><span class="badge">${cloud.rounds.length} rodadas</span>${cloud.canEdit() ? `<button class="btn primary small-btn" data-action="open-create-round">+ Rodada</button>` : ""}</div><div class="stack">
      ${cloud.rounds.map((round) => `<div class="save-row"><button class="btn full split" data-action="open-round" data-round="${round.id}"><span style="text-align:left">${esc(round.name)}<br><small class="muted">${formatDate(round.round_date)} · ${round.finalized ? "finalizada" : "em andamento"}</small></span><span>›</span></button>${cloud.isOwner() ? `<button class="icon-btn" data-action="confirm-delete-round" data-round="${round.id}" aria-label="Apagar ${esc(round.name)}">×</button>` : ""}</div>`).join("") || `<div class="empty">Nenhuma rodada criada ainda.</div>`}
    </div></section></main>`;
}

function renderGeneralStats() {
  const byGoals = [...cloud.totals].sort((a, b) => Number(b.goals) - Number(a.goals) || a.name.localeCompare(b.name, "pt-BR"));
  const byWins = [...cloud.totals].sort((a, b) => Number(b.wins) - Number(a.wins) || a.name.localeCompare(b.name, "pt-BR"));
  const ranking = (players, field, suffix) => players.map((player, index) => `<div class="ranking-row ${index < 3 ? "podium" : ""}"><span class="ranking-position">${index + 1}</span><span class="ranking-name">${esc(player.nickname || player.name)}</span><strong class="ranking-value">${player[field]} ${suffix}</strong></div>`).join("");
  return `<main class="page">${clubSectionHead("Somatorio das rodadas", "Estatisticas gerais")}
    <div class="rankings-grid"><article class="card ranking-card"><div class="ranking-head"><span class="team-label">Artilharia</span></div>${ranking(byGoals, "goals", "G") || `<div class="empty">Sem dados.</div>`}</article><article class="card ranking-card"><div class="ranking-head"><span class="team-label">Vitorias</span></div>${ranking(byWins, "wins", "V") || `<div class="empty">Sem dados.</div>`}</article></div>
    <section class="card"><div class="section-head"><h2>Todos os jogadores</h2></div>${cloud.totals.map((player) => `<div class="general-stat-row"><span class="ranking-name">${esc(player.nickname || player.name)}</span><span class="pill">${player.games} J</span><span class="pill">${player.wins} V</span><span class="pill">${player.goals} G</span></div>`).join("") || `<div class="empty">As estatisticas aparecerao apos as rodadas.</div>`}</section>
  </main>`;
}

function renderList(session) {
  const activeCount = activePlayerCount(session);
  const listFull = activeCount >= MAX_PLAYERS;
  const presentIds = new Set(session.players.map((player) => player.id));
  const availablePlayers = cloud.players.filter((player) => !presentIds.has(player.id));
  return `
    <main class="page">
      <section class="card">
        <div class="section-head"><div><p class="eyebrow">Ordem de chegada</p><h2>Lista de jogadores</h2></div><span class="badge">${activeCount}/${MAX_PLAYERS}</span></div>
        <p class="muted small" style="margin-bottom:10px">Toque nos cadastrados conforme eles chegam. A ordem dos cliques define a fila do dia.</p>
        <div class="registered-grid">
          ${availablePlayers.map((player) => `<button class="btn registered-player" data-action="add-registered" data-player="${player.id}" ${listFull || !cloud.canEdit() ? "disabled" : ""}>+ ${esc(player.nickname || player.name)}</button>`).join("") || `<span class="muted small">Todos os cadastrados já foram adicionados.</span>`}
        </div>
        <div class="divider"></div>
        <p class="eyebrow">Jogador novo ou avulso</p>
        <form class="add-form" data-form="add-player">
          <input class="input" name="name" placeholder="${listFull ? "Lista completa" : "Nome do jogador"}" autocomplete="off" required ${listFull ? "disabled" : ""} />
          <button class="btn primary" type="submit" ${listFull || !cloud.canEdit() ? "disabled" : ""}>Adicionar</button>
        </form>
        ${listFull ? `<p class="muted small" style="margin-top:9px">Limite de 28 jogadores atingido.</p>` : ""}
        ${!session.generated ? `<button class="btn full" style="margin-top:9px" data-action="generate" ${session.players.length < 12 || !cloud.canEdit() ? "disabled" : ""}>Sortear e gerar times ${session.players.length < 12 ? `(${12 - session.players.length} restantes)` : ""}</button>` : ""}
      </section>
      ${session.generated ? `
        <div class="team-grid">
          ${allActiveTeams(session).map((team) => renderTeam(team, { removable: cloud.canEdit() })).join("")}
        </div>
      ` : `
        <section class="card">
          <div class="section-head"><h2>Inscritos</h2><span class="badge">${session.players.length}/12 mínimo</span></div>
          ${session.players.map((player, index) => `<div class="player"><span class="number">${index + 1}</span><span class="player-name">${esc(player.name)}</span><button class="icon-btn" data-action="remove-attendance" data-player="${player.id}" aria-label="Retirar ${esc(player.name)} da lista">×</button></div>`).join("") || `<div class="empty">Adicione os jogadores na ordem em que chegaram.</div>`}
        </section>`}
      <section class="card">
        <div class="section-head"><div><p class="eyebrow">Lesão ou desistência</p><h2>Fora da pelada</h2></div><span class="badge">${session.removed.length}</span></div>
        ${session.removed.map((player) => `<div class="player"><span class="player-name">${esc(player.name)}</span><button class="btn small-btn" data-action="restore-player" data-player="${player.id}" ${listFull ? "disabled" : ""}>Voltar para a fila</button></div>`).join("") || `<div class="empty">Quem sair da pelada aparecerá aqui e poderá voltar ao fim da fila.</div>`}
      </section>
    </main>`;
}

function renderTeams(session) {
  const game = session.current;
  return `
    <main class="page">
      <section class="card hero">
        <p class="eyebrow">Em campo agora</p>
        ${game ? `<div class="matchup"><div class="matchup-team"><strong>${game.home.label}</strong><span>${game.home.players.length} jogadores</span></div><div class="versus">VS</div><div class="matchup-team"><strong>${game.away.label}</strong><span>${game.away.players.length} jogadores</span></div></div>` : `<div class="empty">Aguardando dois times completos.</div>`}
      </section>
      <section>
        <div class="section-head"><h2>Times em campo</h2></div>
        <div class="team-grid">${game ? `${renderTeam(game.home, { current: true })}${renderTeam(game.away, { current: true })}` : ""}</div>
      </section>
      <section>
        <div class="section-head"><h2>Próximos da fila</h2><span class="badge">${session.waiting.length} times</span></div>
        <div class="team-grid">${session.waiting.map((team) => renderTeam(team)).join("") || `<div class="card empty">Nenhum time na espera.</div>`}</div>
      </section>
    </main>`;
}

function renderMatch(session) {
  const game = session.current;
  if (!game) return `<main class="page"><section class="card empty">Não há uma partida disponível. Adicione jogadores para completar os próximos times.</section></main>`;
  return `
    <main class="page">
      <section class="card">
        <div class="section-head"><span class="badge live"><span class="dot"></span> partida atual</span><span class="muted small">10 minutos</span></div>
        <div class="timer">${formatTimer(game.seconds)}</div>
        <div class="timer-actions">
          <button class="btn primary" data-action="start-timer" ${game.running || !cloud.canEdit() ? "disabled" : ""}>Iniciar</button>
          <button class="btn" data-action="stop-timer" ${!game.running || !cloud.canEdit() ? "disabled" : ""}>Pausar</button>
          <button class="btn" data-action="reset-timer" ${!cloud.canEdit() ? "disabled" : ""}>Reiniciar</button>
        </div>
        <div class="scoreboard compact">
          <div class="score-team"><strong>${teamName(game.home)}</strong><span class="score">${game.homeScore}</span></div>
          <div class="score-x">×</div>
          <div class="score-team"><strong>${teamName(game.away)}</strong><span class="score">${game.awayScore}</span></div>
        </div>
        <button class="btn warning full" style="margin-top:16px" data-action="open-finish" ${!cloud.canEdit() ? "disabled" : ""}>Finalizar partida</button>
      </section>
      <section class="card">
        <div class="section-head"><h2>Súmula</h2><span class="badge">${game.goals.length} gols</span></div>
        <p class="muted small" style="margin-bottom:8px">Adicione ou corrija os gols diretamente na lista.</p>
        ${["home", "away"].map((side) => {
          const team = game[side];
          return `<div class="summary-team">
            <div class="summary-team-head"><span class="team-label">${teamName(team)}</span><span class="badge">${game[`${side}Score`]} gols</span></div>
            ${team.players.map((player) => {
              const goals = matchGoals(game, player.id);
              return `<div class="scorer-row">
                <span class="player-name">${esc(player.name)}</span>
                <button class="score-btn minus" data-action="remove-goal" data-side="${side}" data-player="${player.id}" aria-label="Remover gol de ${esc(player.name)}" ${!goals || !cloud.canEdit() ? "disabled" : ""}>−</button>
                <strong class="player-goals">${goals}</strong>
                <button class="score-btn plus" data-action="goal" data-side="${side}" data-player="${player.id}" aria-label="Adicionar gol de ${esc(player.name)}" ${!cloud.canEdit() ? "disabled" : ""}>+</button>
              </div>`;
            }).join("")}
          </div>`;
        }).join("")}
      </section>
    </main>`;
}

function renderStats(session) {
  const activePlayers = session.players;
  const topGoals = [...activePlayers].sort((a, b) => b.goals - a.goals)[0];
  const topWins = [...activePlayers].sort((a, b) => b.wins - a.wins)[0];
  const goalRanking = [...activePlayers].sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name, "pt-BR"));
  const winRanking = [...activePlayers].sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name, "pt-BR"));
  const renderRanking = (players, stat) => players.map((player, index) => `
    <div class="ranking-row ${index < 3 ? "podium" : ""}">
      <span class="ranking-position">${index + 1}</span>
      <span class="ranking-name">${esc(player.name)}</span>
      <strong class="ranking-value">${player[stat]}</strong>
    </div>
  `).join("");
  return `
    <main class="page">
      <section class="card hero"><p class="eyebrow">Resumo da rodada</p><h2>Números do futebol</h2><p>Estatísticas atualizadas conforme as partidas são encerradas.</p></section>
      <div class="grid two">
        <div class="stat"><span class="stat-value">${session.games.length}</span><span class="stat-label">Jogos</span></div>
        <div class="stat"><span class="stat-value">${session.games.reduce((sum, game) => sum + game.homeScore + game.awayScore, 0)}</span><span class="stat-label">Gols</span></div>
      </div>
      <section class="card">
        <div class="section-head"><h2>Destaques</h2></div>
        <div class="stack">
          <div class="stat"><span class="stat-label">Artilheiro</span><div class="split" style="margin-top:7px"><strong>${esc(topGoals?.name || "Sem gols")}</strong><span class="pill">${topGoals?.goals || 0} gols</span></div></div>
          <div class="stat"><span class="stat-label">Mais vitórias</span><div class="split" style="margin-top:7px"><strong>${esc(topWins?.name || "Sem jogos")}</strong><span class="pill">${topWins?.wins || 0} vitórias</span></div></div>
        </div>
      </section>
      <section>
        <div class="section-head"><h2>Rankings do dia</h2><span class="badge">${activePlayers.length} jogadores</span></div>
        <div class="rankings-grid">
          <article class="card ranking-card">
            <div class="ranking-head"><span class="team-label">Artilharia</span><span class="muted small">Gols</span></div>
            ${renderRanking(goalRanking, "goals") || `<div class="empty">Sem jogadores.</div>`}
          </article>
          <article class="card ranking-card">
            <div class="ranking-head"><span class="team-label">Vitórias</span><span class="muted small">Jogos</span></div>
            ${renderRanking(winRanking, "wins") || `<div class="empty">Sem jogadores.</div>`}
          </article>
        </div>
      </section>
    </main>`;
}

function renderHistory(session) {
  return `
    <main class="page">
      <section class="card">
        <div class="section-head"><div><p class="eyebrow">Partidas encerradas</p><h2>Histórico do dia</h2></div><span class="badge">${session.games.length}</span></div>
        ${[...session.games].reverse().map((game, index) => `
          <div class="history-item">
            <div class="split"><span class="muted small">Jogo ${session.games.length - index}</span><span class="badge">${game.goals.length} gols</span></div>
            <div class="history-score"><span>${teamName(game.home)}</span> ${game.homeScore} × ${game.awayScore} <span>${teamName(game.away)}</span></div>
            <div class="muted small">${game.goals.map((goal) => `${goal.playerName} ${goal.minute}'`).join(" · ") || "Sem gols"}</div>
          </div>
        `).join("") || `<div class="empty">As partidas finalizadas serão salvas aqui.</div>`}
      </section>
      <section class="card">
        <div class="section-head"><h2>Movimentações</h2></div>
        ${[...session.events].reverse().map((event) => `<div class="goal-event"><span class="muted small">${new Date(event.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span><span>${esc(event.text)}</span></div>`).join("") || `<div class="empty">Sem movimentações.</div>`}
      </section>
    </main>`;
}

function renderModal(session) {
  if (!ui.modal) return "";
  if (ui.modal.type === "create-club") {
    return `<div class="modal-wrap"><section class="modal"><div class="section-head"><div><p class="eyebrow">Nova casa</p><h2>Criar pelada fixa</h2></div><button class="icon-btn" data-action="close-modal">×</button></div><form class="grid" data-form="create-club"><div class="field"><label>Nome da pelada</label><input class="input" name="name" placeholder="Ex.: Fut 100 Qualidade" required /></div><div class="field"><label>Iniciais ou escudo</label><input class="input" name="initials" maxlength="4" placeholder="Ex.: F100" required /></div><button class="btn primary full">Criar pelada</button></form></section></div>`;
  }
  if (ui.modal.type === "add-roster") {
    return `<div class="modal-wrap"><section class="modal"><div class="section-head"><div><p class="eyebrow">Elenco fixo</p><h2>Cadastrar jogador</h2></div><button class="icon-btn" data-action="close-modal">×</button></div><form class="grid" data-form="add-roster"><div class="field"><label>Nome completo</label><input class="input" name="name" required /></div><div class="field"><label>Apelido opcional</label><input class="input" name="nickname" /></div><button class="btn primary full">Cadastrar jogador</button></form></section></div>`;
  }
  if (ui.modal.type === "create-round") {
    const today = new Date().toISOString().slice(0, 10);
    return `<div class="modal-wrap"><section class="modal"><div class="section-head"><div><p class="eyebrow">Novo save</p><h2>Criar rodada</h2></div><button class="icon-btn" data-action="close-modal">×</button></div><form class="grid" data-form="create-round"><div class="field"><label>Nome</label><input class="input" name="name" value="${roundDefaultName()}" required /></div><div class="field"><label>Data</label><input class="input" name="date" type="date" value="${today}" required /></div><p class="muted small">Depois de criar, adicione os presentes pela Lista na ordem em que chegarem.</p><button class="btn primary full">Criar rodada</button></form></section></div>`;
  }
  if (ui.modal.type === "remove-roster") {
    const player = cloud.players.find((item) => item.id === ui.modal.playerId);
    return `<div class="modal-wrap"><section class="modal"><p class="eyebrow">Remover jogador</p><h2>${esc(player?.nickname || player?.name || "Jogador")}</h2><p class="muted small" style="margin-top:8px">Ele deixará de aparecer no elenco para as próximas rodadas. O histórico anterior será preservado.</p><div class="grid two" style="margin-top:15px"><button class="btn" data-action="close-modal">Cancelar</button><button class="btn danger" data-action="remove-roster" data-player="${ui.modal.playerId}">Remover</button></div></section></div>`;
  }
  if (ui.modal.type === "delete-round") {
    const round = cloud.rounds.find((item) => item.id === ui.modal.roundId);
    return `<div class="modal-wrap"><section class="modal"><p class="eyebrow">Apagar save</p><h2>${esc(round?.name || "Rodada")}</h2><p class="muted small" style="margin-top:8px">Esta ação remove a rodada e suas estatísticas. Ela não pode ser desfeita.</p><div class="grid two" style="margin-top:15px"><button class="btn" data-action="close-modal">Cancelar</button><button class="btn danger" data-action="delete-round" data-round="${ui.modal.roundId}">Apagar save</button></div></section></div>`;
  }
  if (ui.modal.type === "create") {
    return `<div class="modal-wrap"><section class="modal"><div class="section-head"><div><p class="eyebrow">Novo save</p><h2>Criar pelada</h2></div><button class="icon-btn" data-action="close-modal">×</button></div><form class="grid" data-form="create-session"><div class="field"><label>Nome</label><input class="input" name="name" value="Futebol de quarta" required /></div><div class="field"><label>Data</label><input class="input" name="date" type="date" value="${new Date().toISOString().slice(0, 10)}" required /></div><button class="btn primary full" type="submit">Criar e montar lista</button></form></section></div>`;
  }
  if (ui.modal.type === "goal") {
    const team = session.current[ui.modal.side];
    return `<div class="modal-wrap"><section class="modal"><div class="section-head"><div><p class="eyebrow">${teamName(team)}</p><h2>Quem fez o gol?</h2></div><button class="icon-btn" data-action="close-modal">×</button></div><div class="grid">${team.players.map((player) => `<button class="btn full split" data-action="goal" data-side="${ui.modal.side}" data-player="${player.id}"><span>${esc(player.name)}</span><span>+1</span></button>`).join("")}</div></section></div>`;
  }
  if (ui.modal.type === "finish") {
    const game = session.current;
    const isDraw = game.homeScore === game.awayScore;
    const enoughWaiting = session.waiting.filter((team) => team.players.length === TEAM_SIZE).length >= 2;
    return `<div class="modal-wrap"><section class="modal"><div class="section-head"><div><p class="eyebrow">Encerrar partida</p><h2>${isDraw ? "Como resolver o empate?" : "Confirmar resultado"}</h2></div><button class="icon-btn" data-action="close-modal">×</button></div>
      <p class="muted small">${teamName(game.home)} ${game.homeScore} × ${game.awayScore} ${teamName(game.away)}</p>
      <div class="grid">
        ${isDraw ? `
          <button class="btn full split" data-action="finish-game" data-mode="win" data-side="home"><span>${game.home.label} venceu no ímpar ou par</span><span>›</span></button>
          <button class="btn full split" data-action="finish-game" data-mode="win" data-side="away"><span>${game.away.label} venceu no ímpar ou par</span><span>›</span></button>
          <button class="btn full split" data-action="draw-order" ${!enoughWaiting ? "disabled" : ""}><span>Os dois saem de campo</span><span>›</span></button>
          ${!enoughWaiting ? `<p class="muted small">Essa opção exige dois times completos aguardando.</p>` : ""}
        ` : `<button class="btn primary full" data-action="finish-game" data-mode="win">Salvar e chamar próximo time</button>`}
      </div></section></div>`;
  }
  if (ui.modal.type === "draw-order") {
    const game = session.current;
    return `<div class="modal-wrap"><section class="modal"><div class="section-head"><div><p class="eyebrow">Ordem da fila</p><h2>Quem sobe primeiro?</h2></div><button class="icon-btn" data-action="close-modal">×</button></div><p class="muted small">Os dois times sairão. Selecione quem entra antes no fim da fila.</p><div class="grid"><button class="btn full" data-action="finish-game" data-mode="draw-exit" data-side="home">${teamName(game.home)} primeiro</button><button class="btn full" data-action="finish-game" data-mode="draw-exit" data-side="away">${teamName(game.away)} primeiro</button></div></section></div>`;
  }
  return "";
}

function renderNav() {
  const items = [
    ["home", "⌂", "Home"], ["list", "☷", "Lista"], ["teams", "◈", "Times"],
    ["match", "◷", "Jogo"], ["stats", "↑", "Stats"], ["history", "≡", "Histórico"],
  ];
  return `<nav class="bottom-nav">${items.map(([page, icon, label]) => `<button class="nav-item ${ui.page === page ? "active" : ""}" data-action="nav" data-page="${page}" ${page !== "home" && !active() ? "disabled" : ""}><span>${icon}</span>${label}</button>`).join("")}</nav>`;
}

function render() {
  const session = active();
  if (!cloud.ready) {
    document.querySelector("#app").innerHTML = `<main class="page"><section class="card empty">Carregando...</section></main>`;
    return;
  }
  let content = "";
  let showNav = Boolean(cloud.club);
  if (!cloud.configured) content = renderSetup();
  else if (!cloud.club) content = cloud.user ? renderClubs() : renderAccess();
  else if (!session || ui.page === "home") {
    if (ui.clubSection === "roster") content = renderClubRoster();
    else if (ui.clubSection === "rounds") content = renderClubRounds();
    else if (ui.clubSection === "general-stats") content = renderGeneralStats();
    else content = renderClubDashboard();
  }
  else {
    if (ui.page === "list") content = renderList(session);
    if (ui.page === "teams") content = renderTeams(session);
    if (ui.page === "match") content = renderMatch(session);
    if (ui.page === "stats") content = renderStats(session);
    if (ui.page === "history") content = renderHistory(session);
  }
  document.querySelector("#app").innerHTML = `
    <div class="shell">
      <header class="topbar"><div><p class="eyebrow">Quarta FC</p><h1>${session && ui.page !== "home" ? esc(session.name) : cloud.club ? esc(cloud.club.name) : "Gerenciador de pelada"}</h1></div>${session && ui.page !== "home" ? `<button class="btn small-btn" data-action="nav" data-page="home">Pelada</button>` : ""}</header>
      ${content}${showNav ? renderNav() : ""}${renderModal(session)}
    </div>`;
}

async function runAction(action) {
  try {
    cloud.notice = "";
    await action();
  } catch (error) {
    cloud.notice = error.message || "Nao foi possivel concluir a acao.";
  }
  render();
}

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.dataset.form === "login") return runAction(() => cloud.signIn(form.email.value, form.password.value));
  if (form.dataset.form === "signup") return runAction(() => cloud.signUp(form.email.value, form.password.value));
  if (form.dataset.form === "access-code") return runAction(() => cloud.join(form.code.value));
  if (form.dataset.form === "create-club") return runAction(async () => { await cloud.createClub(form.name.value, form.initials.value); ui.modal = null; });
  if (form.dataset.form === "add-roster") return runAction(async () => { await cloud.addRosterPlayer(form); ui.modal = null; });
  if (form.dataset.form === "create-round") return runAction(async () => { await cloud.createRound(form); ui.modal = null; });
  if (form.dataset.form === "create-session") createSession(form.name.value, form.date.value);
  if (form.dataset.form === "add-player") {
    const name = form.name.value;
    const saved = cloud.client && cloud.club ? await cloud.registerWalkIn(name) : null;
    addPlayer(name, saved);
    form.reset();
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "nav") { ui.page = button.dataset.page; ui.clubSection = "dashboard"; ui.modal = null; render(); }
  if (action === "club-section") { ui.page = "home"; ui.clubSection = button.dataset.section; ui.modal = null; render(); }
  if (action === "open-create-club") { ui.modal = { type: "create-club" }; render(); }
  if (action === "open-add-roster") { ui.modal = { type: "add-roster" }; render(); }
  if (action === "open-create-round") { ui.modal = { type: "create-round" }; render(); }
  if (action === "open-club") return runAction(() => cloud.openClub(cloud.clubs.find((club) => club.id === button.dataset.club), "owner"));
  if (action === "open-round") cloud.openRound(cloud.rounds.find((round) => round.id === button.dataset.round));
  if (action === "add-registered") addRegisteredPlayer(button.dataset.player);
  if (action === "remove-attendance") removeAttendance(button.dataset.player);
  if (action === "confirm-remove-roster") { ui.modal = { type: "remove-roster", playerId: button.dataset.player }; render(); }
  if (action === "remove-roster") return runAction(async () => { await cloud.removeRosterPlayer(button.dataset.player); ui.modal = null; });
  if (action === "confirm-delete-round") { ui.modal = { type: "delete-round", roundId: button.dataset.round }; render(); }
  if (action === "delete-round") return runAction(async () => { await cloud.deleteRound(button.dataset.round); ui.modal = null; });
  if (action === "close-club") return runAction(() => cloud.closeClub());
  if (action === "logout") return runAction(() => cloud.signOut());
  if (action === "rotate-edit-code") return runAction(() => cloud.rotateEditCode());
  if (action === "open-create") { ui.modal = { type: "create" }; render(); }
  if (action === "close-modal") { ui.modal = null; render(); }
  if (action === "open-session") { data.activeId = button.dataset.session; ui.page = "list"; save(); render(); }
  if (action === "generate") generateTeams();
  if (action === "delete-before-generate") {
    if (!cloud.canEdit()) return;
    const session = active();
    session.players = session.players.filter((player) => player.id !== button.dataset.player);
    save(); render();
  }
  if (action === "remove-player") removePlayer(button.dataset.player);
  if (action === "restore-player") restorePlayer(button.dataset.player);
  if (action === "start-timer") startTimer();
  if (action === "stop-timer") stopTimer();
  if (action === "reset-timer") resetTimer();
  if (action === "open-goal") { ui.modal = { type: "goal", side: button.dataset.side }; render(); }
  if (action === "goal") addGoal(button.dataset.side, button.dataset.player);
  if (action === "remove-goal") removeGoal(button.dataset.side, button.dataset.player);
  if (action === "open-finish") { ui.modal = { type: "finish" }; render(); }
  if (action === "draw-order") { ui.modal = { type: "draw-order" }; render(); }
  if (action === "finish-game") finishGame(button.dataset.mode, button.dataset.side || null);
});

cloud.init();
