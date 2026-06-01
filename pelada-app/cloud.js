const cloud = {
  client: null,
  configured: false,
  ready: false,
  user: null,
  accessCode: sessionStorage.getItem("quarta-fc-access-code") || "",
  mode: sessionStorage.getItem("quarta-fc-access-mode") || "",
  clubs: [],
  club: null,
  rounds: [],
  players: [],
  totals: [],
  notice: "",
  persistTimer: null,
  pollTimer: null,

  async init() {
    const config = window.QUARTA_FC_CONFIG || {};
    this.configured = Boolean(config.supabaseUrl && config.supabaseAnonKey && window.supabase);
    if (!this.configured) {
      this.ready = true;
      render();
      return;
    }
    this.client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    const { data } = await this.client.auth.getSession();
    this.user = data.session?.user || null;
    if (this.user) await this.loadClubs();
    this.ready = true;
    render();
  },

  canEdit() {
    return this.mode === "owner" || this.mode === "edit";
  },

  isOwner() {
    return this.mode === "owner";
  },

  code() {
    return this.isOwner() ? null : this.accessCode;
  },

  async rpc(name, args = {}) {
    const { data: result, error } = await this.client.rpc(name, args);
    if (error) throw error;
    return result;
  },

  async signIn(email, password) {
    const { data: result, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.user = result.user;
    this.mode = "";
    await this.loadClubs();
  },

  async signUp(email, password) {
    const { error } = await this.client.auth.signUp({ email, password });
    if (error) throw error;
    this.notice = "Cadastro criado. Confirme seu e-mail antes de entrar.";
  },

  async signOut() {
    clearInterval(this.pollTimer);
    await this.client.auth.signOut();
    this.user = null;
    this.club = null;
    this.clubs = [];
    this.rounds = [];
    this.players = [];
    this.mode = "";
    this.accessCode = "";
    sessionStorage.removeItem("quarta-fc-access-code");
    sessionStorage.removeItem("quarta-fc-access-mode");
    data.activeId = null;
    saveLocal();
  },

  async join(code) {
    const clean = code.trim().toUpperCase();
    const rows = await this.rpc("access_pelada", { p_code: clean });
    if (!rows?.length) throw new Error("Código não encontrado.");
    this.accessCode = clean;
    this.mode = rows[0].access_mode;
    sessionStorage.setItem("quarta-fc-access-code", clean);
    sessionStorage.setItem("quarta-fc-access-mode", this.mode);
    await this.openClub(rows[0]);
  },

  async loadClubs() {
    this.clubs = await this.rpc("list_my_peladas");
  },

  async createClub(name, initials) {
    const rows = await this.rpc("create_pelada", { p_name: name, p_initials: initials });
    const club = rows[0];
    this.notice = `Pelada criada. Visualização: ${club.view_code} · Edição: ${club.edit_code}`;
    await this.loadClubs();
    await this.openClub(club, "owner");
  },

  async openClub(club, mode = null) {
    this.club = club;
    this.mode = mode || this.mode || "owner";
    if (this.mode === "owner") this.accessCode = "";
    await Promise.all([this.loadRounds(), this.loadPlayers(), this.loadTotals()]);
    data.activeId = null;
    ui.page = "home";
    saveLocal();
  },

  async closeClub() {
    clearInterval(this.pollTimer);
    this.club = null;
    this.rounds = [];
    this.players = [];
    this.totals = [];
    data.activeId = null;
    if (!this.user) {
      this.mode = "";
      this.accessCode = "";
      sessionStorage.removeItem("quarta-fc-access-code");
      sessionStorage.removeItem("quarta-fc-access-mode");
    }
    saveLocal();
  },

  async loadRounds() {
    this.rounds = await this.rpc("list_rounds", { p_pelada_id: this.club.id, p_code: this.code() });
  },

  async loadPlayers() {
    this.players = await this.rpc("list_players", { p_pelada_id: this.club.id, p_code: this.code() });
  },

  async loadTotals() {
    this.totals = await this.rpc("pelada_player_totals", { p_pelada_id: this.club.id, p_code: this.code() });
  },

  async addRosterPlayer(form) {
    await this.rpc("save_player", {
      p_pelada_id: this.club.id,
      p_code: this.code(),
      p_name: form.name.value,
      p_nickname: form.nickname.value,
      p_initials: null,
      p_position: null,
      p_photo_url: null,
    });
    await this.loadPlayers();
  },

  async removeRosterPlayer(playerId) {
    await this.rpc("remove_player", { p_player_id: playerId });
    await Promise.all([this.loadPlayers(), this.loadTotals()]);
  },

  async registerWalkIn(name) {
    const player = await this.rpc("save_player", {
      p_pelada_id: this.club.id,
      p_code: this.code(),
      p_name: name,
      p_nickname: null,
      p_initials: null,
      p_position: null,
      p_photo_url: null,
    });
    await this.loadPlayers();
    return player;
  },

  async createRound(form) {
    const state = {
      name: form.name.value, date: form.date.value, createdAt: new Date().toISOString(),
      teamCounter: 0, players: [], removed: [], waiting: [], current: null,
      games: [], events: [], generated: false,
    };
    const round = await this.rpc("create_round", {
      p_pelada_id: this.club.id, p_code: this.code(), p_name: state.name,
      p_round_date: state.date, p_state: state,
    });
    await this.loadRounds();
    this.openRound(round);
  },

  async deleteRound(roundId) {
    await this.rpc("delete_round", { p_round_id: roundId });
    data.sessions = data.sessions.filter((session) => session.id !== roundId);
    if (data.activeId === roundId) data.activeId = null;
    await Promise.all([this.loadRounds(), this.loadTotals()]);
    saveLocal();
  },

  openRound(round) {
    const session = { ...round.state, id: round.id, name: round.name, date: round.round_date };
    data.sessions = data.sessions.filter((item) => item.id !== session.id);
    data.sessions.unshift(session);
    data.activeId = session.id;
    ui.page = "list";
    saveLocal();
    this.startRoundPolling();
    render();
  },

  startRoundPolling() {
    clearInterval(this.pollTimer);
    if (this.canEdit()) return;
    this.pollTimer = setInterval(async () => {
      try {
        await this.loadRounds();
        const fresh = this.rounds.find((round) => round.id === data.activeId);
        if (!fresh) return;
        const session = { ...fresh.state, id: fresh.id, name: fresh.name, date: fresh.round_date };
        data.sessions = data.sessions.filter((item) => item.id !== session.id);
        data.sessions.unshift(session);
        saveLocal();
        render();
      } catch {
        // Mantem a ultima versao visivel se a conexao oscilar na quadra.
      }
    }, 3000);
  },

  persist(session) {
    if (!this.client || !this.club || !session?.id || !this.canEdit()) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(async () => {
      try {
        await this.rpc("save_round_state", { p_round_id: session.id, p_code: this.code(), p_state: session, p_finalized: false });
        await this.rpc("save_round_stats", { p_round_id: session.id, p_code: this.code(), p_stats: roundStats(session) });
      } catch (error) {
        this.notice = `Falha ao sincronizar: ${error.message}`;
        render();
      }
    }, 350);
  },

  async rotateEditCode() {
    const code = await this.rpc("rotate_edit_code", { p_pelada_id: this.club.id });
    this.notice = `Novo código de edição: ${code}`;
  },
};

function roundStats(session) {
  const stats = new Map(session.players.map((player) => [player.id, {
    player_id: player.id, games: 0, wins: 0, losses: 0, draws: 0,
    goals: player.goals || 0, assists: 0, mvp: 0, best_win_streak: 0,
  }]));
  for (const game of session.games) {
    const isDraw = game.homeScore === game.awayScore;
    for (const side of ["home", "away"]) {
      const won = !isDraw && game[`${side}Score`] > game[side === "home" ? "awayScore" : "homeScore"];
      for (const player of game[side].players) {
        const item = stats.get(player.id);
        if (!item) continue;
        item.games += 1;
        if (isDraw) item.draws += 1;
        else if (won) item.wins += 1;
        else item.losses += 1;
      }
    }
  }
  return [...stats.values()].filter((item) => /^[0-9a-f-]{36}$/i.test(item.player_id));
}
