/* global Module, Log, Spotify */
Module.register("MMM-SpotifyPlayer", {

  modeActuel: "basic",

  defaults: {
    title: "Spotify",

    /* --- Rythmes --- */
    updateInterval: 2000,
    queueInterval: 15000,
    tickInterval: 250,

    /* --- Mise en page --- */
    fullscreen: true,
    uiScale: 1,
    maxWidth: "560px",
    titleLines: 2,
    autoFitText: true,

    /* --- Fonctionnalités --- */
    controlsEnabled: true,
    showQueue: true,
    queueLength: 3,
    showVolume: true,
    showShuffleRepeat: true,
    showLike: true,
    showLossless: false,
    losslessLabel: "LOSSLESS",
    showDevice: true,

    /* --- Appareils --- */
    showDeviceButton: true,
    deviceRefresh: 5000,
    preferredDevice: "",

    /* --- Apparence --- */
    accentFromArtwork: true,
    blurredArtwork: false,
    fallbackAccent: "#1e6bff",
    hideWhenIdle: false,

    /* --- Lecteur local (Web Playback SDK) --- */
    localPlayer: false,
    localPlayerName: "MagicMirror",
    localPlayerVolume: 0.6,
    localPlayerAutoConnect: false
  },

  getStyles() {
    return [this.file("MMM-SpotifyPlayer.css")];
  },

  getTranslations() {
    return { en: "translations/en.json", fr: "translations/fr.json" };
  },

  /* ==================================================================
     Cycle de vie
     ================================================================== */
  start() {
    this.domReady = false;
    this.state = null;
    this.queue = [];
    this.devices = [];
    this.devOpen = false;

    /* Lecteur local */
    this.localDeviceId = null;
    this.localStatus = this.config.localPlayer ? "loading" : "off";
    this.localError = "";
    this.audioUnlocked = false;

    this.errorCode = null;
    this.dragging = null;
    this.suppressUntil = 0;
    this.artUrl = null;
    this.local = { progress: 0, duration: 0, playing: false, at: Date.now() };

    this.sendSocketNotification("SP_CONFIG", this.config);
    this.ticker = setInterval(() => this.tick(), this.config.tickInterval);
  },

  suspend() {
    clearInterval(this.ticker);
    clearInterval(this._devT);
  },

  resume() {
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.tick(), this.config.tickInterval);
    this.measure();
    this.refitAll();
  },

  /* ==================================================================
     Sockets
     ================================================================== */
  socketNotificationReceived(n, p) {
    if (n === "SP_STATE") {
      this.errorCode = null;

      if (!p.active) {
        this.state = null;
        this.local.playing = false;
        if (this.config.hideWhenIdle) this.hide(400);
      } else {
        if (this.config.hideWhenIdle && this.hidden) this.show(400);
        const wasDragging = this.dragging === "seek";
        this.state = p;
        this.local.duration = p.duration;
        this.local.playing = p.playing;
        if (!wasDragging && Date.now() > this.suppressUntil) {
          this.local.progress = p.progress;
          this.local.at = Date.now();
        }
        if (p.art) this.applyArtwork(p.art);
      }
      this.render();

    } else if (n === "SP_QUEUE") {
      this.queue = p || [];
      this.renderQueue();

    } else if (n === "SP_DEVICES") {
      this.devices = p || [];
      this.renderDevices();

    } else if (n === "SP_TOKEN") {
      this.initLocalPlayer(p);

    } else if (n === "SP_ERROR") {
      if (["NO_TOKEN", "NO_CREDENTIALS", "NO_DEVICE"].includes(p.code)) {
        this.errorCode = p.code;
        this.render();
      }
      Log.warn("[MMM-SpotifyPlayer]", p.code, p.message || "");
    }
  },

  /* ==================================================================
     Notifications MagicMirror
     ================================================================== */
  notificationReceived(notification, payload) {
    switch (notification) {
      case "DOM_OBJECTS_CREATED":
        this.domReady = true;
        this.observeSize();
        this.applyMode(0);
        break;

      case "MODE_CHANGE":
        this.modeActuel = payload;
        this.applyMode(300);
        break;

      case "SPOTIFY_PLAY":     this.act("play"); break;
      case "SPOTIFY_PAUSE":    this.act("pause"); break;
      case "SPOTIFY_TOGGLE":   this.act(this.local.playing ? "pause" : "play"); break;
      case "SPOTIFY_NEXT":     this.act("next"); break;
      case "SPOTIFY_PREVIOUS": this.act("previous"); break;
      case "SPOTIFY_VOLUME":   this.act("volume", payload); break;
      case "SPOTIFY_SEEK":     this.act("seek", payload); break;
      case "SPOTIFY_DEVICE":   this.act("transfer", { name: payload, play: true }); break;
      case "SPOTIFY_PLAY_HERE": this.playHere(); break;
    }
  },

  applyMode(speed = 300) {
    if (!this.domReady) return;
    const visible = this.modeActuel === "musique";
    const opts = { lockString: this.identifier };

    if (visible) {
      this.show(speed, opts);
      setTimeout(() => { this.measure(); this.refitAll(); }, speed + 60);
    } else {
      this.toggleDevices(false);
      this.hide(speed, opts);
    }
  },

  act(action, value) {
    this.sendSocketNotification("SP_ACTION", { action, value });
  },

  tick() {
    if (!this.state || !this.local.playing || this.dragging === "seek") return;
    const now = Date.now();
    this.local.progress = Math.min(
      this.local.duration,
      this.local.progress + (now - this.local.at)
    );
    this.local.at = now;
    this.renderProgress();
  },

  /* ==================================================================
     Responsive
     ================================================================== */
  observeSize() {
    if (!this.dom || this._ro) return;
    const run = () => this.measure();

    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(run);
      this._ro.observe(this.dom);
      if (this.els.artCell) this._ro.observe(this.els.artCell);
      if (this.els.meta) this._ro.observe(this.els.meta);
    }
    window.addEventListener("resize", run);
    window.addEventListener("orientationchange", () => setTimeout(run, 150));
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => this.refitAll());
    }
    run();
  },

  measure() {
    const el = this.dom;
    if (!el) return;

    const w = el.clientWidth  || window.innerWidth;
    const h = el.clientHeight || window.innerHeight;
    if (!w || !h) return;

    el.style.setProperty("--sp-u", (Math.min(w, h) / 100) + "px");

    const ratio = w / h;
    el.classList.toggle("sp-landscape", ratio > 1.15);
    el.classList.toggle("sp-portrait",  ratio <= 1.15);
    el.classList.toggle("sp-wide",      ratio > 2.2);
    el.classList.toggle("sp-narrow",    w < 430);
    el.classList.toggle("sp-tiny",      Math.min(w, h) < 330);

    this.sizeArt();

    clearTimeout(this._fitT);
    this._fitT = setTimeout(() => this.refitAll(), 60);
  },

  sizeArt() {
    const cell = this.els && this.els.artCell;
    const box  = this.els && this.els.artBox;
    if (!cell || !box) return;
    const s = Math.floor(Math.min(cell.clientWidth, cell.clientHeight));
    if (s > 0 && s !== this._artSize) {
      this._artSize = s;
      box.style.width  = s + "px";
      box.style.height = s + "px";
    }
  },

  /* ==================================================================
     Anti-débordement du texte
     ================================================================== */
  fitText(el, cssVar, minScale = 0.6) {
    if (!el || !this.config.autoFitText) return;
    el.style.setProperty(cssVar, "1");
    if (!el.clientWidth) return;

    const overflows = () =>
      el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;

    if (!overflows()) return;

    let s = 1, guard = 12;
    while (s > minScale && guard-- > 0 && overflows()) {
      s = Math.round((s - 0.05) * 100) / 100;
      el.style.setProperty(cssVar, String(s));
    }
  },

  refitAll() {
    if (!this.els) return;
    requestAnimationFrame(() => {
      this.fitText(this.els.title,  "--sp-fit-title",  0.55);
      this.fitText(this.els.artist, "--sp-fit-artist", 0.65);
    });
  },

  /* ==================================================================
     Construction du DOM
     ================================================================== */
  getDom() {
    if (!this.dom) this.dom = this.build();
    this.render();
    return this.dom;
  },

  svg(paths, opts = {}) {
    return `<svg viewBox="0 0 24 24" fill="${opts.fill || "none"}" stroke="${
      opts.fill ? "none" : "currentColor"
    }" stroke-width="${opts.sw || 1.9}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  },

  icons() {
    return {
      shuffle: this.svg('<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m3 4 5 5"/>'),
      repeat: this.svg('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
      heart: this.svg('<path d="M20.8 5.1a5.4 5.4 0 0 0-7.7 0L12 6.2l-1.1-1.1a5.4 5.4 0 1 0-7.7 7.7l1.1 1.1L12 21.5l7.7-7.6 1.1-1.1a5.4 5.4 0 0 0 0-7.7z"/>'),
      prev: this.svg('<path d="M19.5 5.2v13.6a1 1 0 0 1-1.55.83L8 13.2v5.6a1 1 0 0 1-1.55.83l-.2-.14V4.5l.2-.13A1 1 0 0 1 8 5.2v5.6l9.95-6.43a1 1 0 0 1 1.55.83z"/><rect x="4.5" y="4.2" width="2" height="15.6" rx="1"/>', { fill: 1 }),
      next: this.svg('<path d="M4.5 5.2v13.6a1 1 0 0 0 1.55.83L16 13.2v5.6a1 1 0 0 0 1.55.83l.2-.14V4.5l-.2-.13A1 1 0 0 0 16 5.2v5.6L6.05 4.37A1 1 0 0 0 4.5 5.2z"/><rect x="17.5" y="4.2" width="2" height="15.6" rx="1"/>', { fill: 1 }),
      play: this.svg('<path d="M8.5 5.3v13.4a.8.8 0 0 0 1.22.68l10.3-6.7a.8.8 0 0 0 0-1.36L9.72 4.62A.8.8 0 0 0 8.5 5.3z"/>', { fill: 1 }),
      pause: this.svg('<rect x="7" y="4.5" width="3.6" height="15" rx="1.3"/><rect x="13.4" y="4.5" width="3.6" height="15" rx="1.3"/>', { fill: 1 }),
      volume: this.svg('<path d="M11 5 6.5 8.5H3v7h3.5L11 19z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path d="M18 6.8a7.5 7.5 0 0 1 0 10.4"/>'),

      device: this.svg('<rect x="4" y="2.5" width="16" height="19" rx="3"/><circle cx="12" cy="14.5" r="3.4"/><circle cx="12" cy="6.5" r="1"/>'),
      speaker: this.svg('<rect x="4" y="2.5" width="16" height="19" rx="3"/><circle cx="12" cy="14.5" r="3.4"/><circle cx="12" cy="6.5" r="1"/>'),
      computer: this.svg('<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8 20.5h8"/><path d="M12 16.5v4"/>'),
      smartphone: this.svg('<rect x="6.5" y="2" width="11" height="20" rx="2.5"/><path d="M10.5 18.5h3"/>'),
      tv: this.svg('<rect x="2.5" y="4.5" width="19" height="12" rx="2"/><path d="M8 20.5h8"/>'),
      car: this.svg('<path d="M3 12.5 5 6.5a2 2 0 0 1 1.9-1.4h10.2A2 2 0 0 1 19 6.5l2 6"/><rect x="2" y="12.5" width="20" height="6" rx="2"/><circle cx="7" cy="18.5" r="1.4"/><circle cx="17" cy="18.5" r="1.4"/>'),
      mirror: this.svg('<rect x="3" y="2.5" width="18" height="19" rx="4"/><path d="M8 8.5h8M8 12h8M8 15.5h5"/>'),
      close: this.svg('<path d="M6 6l12 12M18 6 6 18"/>'),
      check: this.svg('<path d="m4 12.5 5 5L20 6.5"/>'),
      warn: this.svg('<path d="M12 3.5 1.8 20.5h20.4z"/><path d="M12 9.5v5"/><path d="M12 17.6v.1"/>'),
      spinner: this.svg('<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" opacity=".9"/>')
    };
  },

  build() {
    const i = this.icons();
    const el = document.createElement("div");

    el.className = "sp-root";
    if (this.config.fullscreen) el.classList.add("sp-fullscreen");
    el.style.setProperty("--sp-max-width", this.config.maxWidth);
    el.style.setProperty("--sp-scale", this.config.uiScale);
    el.style.setProperty("--sp-title-lines", this.config.titleLines);
    el.style.setProperty("--sp-accent", this.config.fallbackAccent);
    if (!this.config.controlsEnabled) el.classList.add("sp-no-controls");

    el.innerHTML = `
      <div class="sp-wrapper">
        <div class="sp-bg"></div>
        ${this.config.blurredArtwork ? '<div class="sp-bg-art"></div>' : ""}
        <div class="sp-content">

          <header class="sp-top">
            <div class="sp-top-l">
              ${this.config.showShuffleRepeat ? `
                <button class="sp-ico" data-act="shuffle" title="Shuffle">${i.shuffle}</button>
                <button class="sp-ico" data-act="repeat" title="Repeat">${i.repeat}<span class="sp-rep-badge">1</span></button>` : ""}
            </div>
            <div class="sp-brand">${this.config.title}</div>
            <div class="sp-top-r">
              ${this.config.showDeviceButton ? `<button class="sp-ico sp-dev-btn" data-act="devices-open" title="Appareils">${i.device}</button>` : ""}
              ${this.config.showLike ? `<button class="sp-ico sp-like" data-act="like" title="Like">${i.heart}</button>` : ""}
              ${this.config.showLossless ? `<span class="sp-lossless">${this.config.losslessLabel}</span>` : ""}
            </div>
          </header>

          <div class="sp-art-cell">
            <div class="sp-art-box">
              <img class="sp-art" alt="" />
              <div class="sp-art-fallback">${i.play}</div>
            </div>
          </div>

          <div class="sp-meta">
            <div class="sp-title">—</div>
            <div class="sp-artist"></div>
          </div>

          <div class="sp-seek-zone">
            <div class="sp-times"><span class="sp-elapsed">0:00</span><span class="sp-duration">0:00</span></div>
            <div class="sp-bar" role="slider" tabindex="0" aria-label="Progression">
              <div class="sp-bar-track"><div class="sp-bar-fill"><span class="sp-knob"></span></div></div>
            </div>
          </div>

          <footer class="sp-bottom">
            <div class="sp-queue">
              <div class="sp-queue-title">${this.translate("NEXT_UP")}</div>
              <ul class="sp-queue-list"></ul>
            </div>

            <div class="sp-controls">
              <button class="sp-ctrl" data-act="previous">${i.prev}</button>
              <button class="sp-play" data-act="toggle">${i.play}</button>
              <button class="sp-ctrl" data-act="next">${i.next}</button>
            </div>

            <div class="sp-vol">
              <span class="sp-vol-ico">${i.volume}</span>
              <div class="sp-vol-bar" role="slider" tabindex="0" aria-label="Volume">
                <div class="sp-vol-track"><div class="sp-vol-fill"><span class="sp-knob sm"></span></div></div>
              </div>
            </div>
          </footer>

          <div class="sp-dev-panel">
            <div class="sp-dev-card">
              <div class="sp-dev-head">
                <span>${this.translate("DEVICES")}</span>
                <button class="sp-dev-close" data-act="devices-close">${i.close}</button>
              </div>
              <ul class="sp-dev-list"></ul>
              <div class="sp-dev-foot"></div>
            </div>
          </div>

          <div class="sp-overlay"><div class="sp-overlay-msg"></div></div>
        </div>
      </div>`;

    this.$ = (s) => el.querySelector(s);
    this.els = {
      wrapper:    this.$(".sp-wrapper"),
      art:        this.$(".sp-art"),
      artCell:    this.$(".sp-art-cell"),
      artBox:     this.$(".sp-art-box"),
      bgArt:      this.$(".sp-bg-art"),
      meta:       this.$(".sp-meta"),
      title:      this.$(".sp-title"),
      artist:     this.$(".sp-artist"),
      elapsed:    this.$(".sp-elapsed"),
      duration:   this.$(".sp-duration"),
      bar:        this.$(".sp-bar"),
      fill:       this.$(".sp-bar-fill"),
      play:       this.$(".sp-play"),
      shuffle:    this.$('[data-act="shuffle"]'),
      repeat:     this.$('[data-act="repeat"]'),
      like:       this.$(".sp-like"),
      queue:      this.$(".sp-queue"),
      queueList:  this.$(".sp-queue-list"),
      vol:        this.$(".sp-vol"),
      volBar:     this.$(".sp-vol-bar"),
      volFill:    this.$(".sp-vol-fill"),
      devBtn:     this.$(".sp-dev-btn"),
      devPanel:   this.$(".sp-dev-panel"),
      devList:    this.$(".sp-dev-list"),
      devFoot:    this.$(".sp-dev-foot"),
      overlay:    this.$(".sp-overlay"),
      overlayMsg: this.$(".sp-overlay-msg")
    };

    if (!this.config.showQueue)  this.els.queue.style.display = "none";
    if (!this.config.showVolume) this.els.vol.style.display = "none";

    if (this.config.controlsEnabled) this.bindEvents(el);
    return el;
  },

  /* ==================================================================
     Événements
     ================================================================== */
  bindEvents(root) {
    root.addEventListener("click", (e) => {

      /* Déverrouille l'audio du navigateur au 1er clic (autoplay policy) */
      this.unlockAudio();

      /* --- Sélection d'un appareil --- */
      const devEl = e.target.closest("[data-dev]");
      if (devEl) {
        const id = devEl.dataset.dev;
        if (id) {
          this.act("transfer", { id, play: this.local.playing });
          this.toggleDevices(false);
        }
        return;
      }

      /* --- Clic hors carte = fermeture --- */
      if (this.devOpen && e.target.classList.contains("sp-dev-panel")) {
        this.toggleDevices(false);
        return;
      }

      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const a = btn.dataset.act;

      if (a === "devices-open")  { this.toggleDevices(true);  return; }
      if (a === "devices-close") { this.toggleDevices(false); return; }
      if (a === "retry-local")   { this.retryLocalPlayer();   return; }

      if (a === "toggle") {
        this.local.playing = !this.local.playing;
        this.local.at = Date.now();
        this.renderPlayButton();
        this.act(this.local.playing ? "play" : "pause");

      } else if (a === "shuffle") {
        if (!this.state) return;
        this.state.shuffle = !this.state.shuffle;
        this.renderToggles();
        this.act("shuffle", this.state.shuffle);

      } else if (a === "repeat") {
        if (!this.state) return;
        const order = ["off", "context", "track"];
        this.state.repeat = order[(order.indexOf(this.state.repeat) + 1) % 3];
        this.renderToggles();
        this.act("repeat", this.state.repeat);

      } else if (a === "like") {
        if (!this.state || !this.state.id) return;
        this.state.liked = !this.state.liked;
        this.renderToggles();
        this.act("like", { id: this.state.id, liked: this.state.liked });

      } else {
        this.act(a);
      }
    });

    /* --- Barre de progression --- */
    const ratio = (el, e) => {
      const r = el.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    };

    const bar = this.els.bar;
    bar.addEventListener("pointerdown", (e) => {
      if (!this.state) return;
      this.dragging = "seek";
      bar.setPointerCapture(e.pointerId);
      this.local.progress = ratio(bar, e) * this.local.duration;
      this.renderProgress();
    });
    bar.addEventListener("pointermove", (e) => {
      if (this.dragging !== "seek") return;
      this.local.progress = ratio(bar, e) * this.local.duration;
      this.renderProgress();
    });
    const endSeek = () => {
      if (this.dragging !== "seek") return;
      this.dragging = null;
      this.local.at = Date.now();
      this.suppressUntil = Date.now() + 1800;
      this.act("seek", Math.round(this.local.progress));
    };
    bar.addEventListener("pointerup", endSeek);
    bar.addEventListener("pointercancel", endSeek);

    /* --- Volume --- */
    const vb = this.els.volBar;
    const setVol = (e, send) => {
      const v = Math.round(ratio(vb, e) * 100);
      if (this.state) this.state.volume = v;
      this.renderVolume();
      if (send) this.act("volume", v);
    };
    vb.addEventListener("pointerdown", (e) => {
      this.dragging = "vol";
      vb.setPointerCapture(e.pointerId);
      setVol(e, false);
    });
    vb.addEventListener("pointermove", (e) => this.dragging === "vol" && setVol(e, false));
    vb.addEventListener("pointerup", (e) => {
      if (this.dragging !== "vol") return;
      this.dragging = null;
      setVol(e, true);
    });
    vb.addEventListener("pointercancel", () => { this.dragging = null; });

    /* --- Molette sur la pochette = volume --- */
    this.els.artBox.addEventListener("wheel", (e) => {
      if (!this.state || this.state.volume === null) return;
      e.preventDefault();
      const v = Math.max(0, Math.min(100, this.state.volume + (e.deltaY < 0 ? 5 : -5)));
      this.state.volume = v;
      this.renderVolume();
      clearTimeout(this._volT);
      this._volT = setTimeout(() => this.act("volume", v), 300);
    }, { passive: false });

    /* --- Échap ferme le panneau --- */
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.devOpen) this.toggleDevices(false);
    });

    /* --- Déverrouillage audio sur n'importe quelle interaction --- */
    ["pointerdown", "keydown"].forEach((ev) =>
      document.addEventListener(ev, () => this.unlockAudio(), { once: false })
    );
  },

  /* ==================================================================
     Appareils
     ================================================================== */
  toggleDevices(open) {
    if (!this.els || !this.els.devPanel) return;
    this.devOpen = !!open;
    this.els.devPanel.classList.toggle("on", this.devOpen);
    clearInterval(this._devT);
    if (this.devOpen) {
      this.act("devices");
      this.renderDevices();
      this._devT = setInterval(() => this.act("devices"), this.config.deviceRefresh);
    }
  },

  deviceIcon(type, isMe) {
    const i = this.icons();
    if (isMe) return i.mirror;
    switch (String(type || "").toLowerCase()) {
      case "computer":   return i.computer;
      case "smartphone":
      case "tablet":     return i.smartphone;
      case "tv":
      case "castvideo":  return i.tv;
      case "automobile": return i.car;
      default:           return i.speaker;
    }
  },

  renderDevices() {
    if (!this.els || !this.els.devList) return;
    const i = this.icons();
    const activeId = this.state ? this.state.deviceId : null;
    const rows = [];

    /* --- Ligne "cet écran" : état du lecteur local --- */
    if (this.config.localPlayer) {
      if (this.localStatus === "ready" && this.localDeviceId) {
        const known = this.devices.some((d) => d.id === this.localDeviceId);
        if (!known) {
          rows.push(this.deviceRow({
            id: this.localDeviceId,
            name: this.config.localPlayerName,
            type: "computer"
          }, activeId, true));
        }
      } else if (this.localStatus === "loading") {
        rows.push(`<li class="sp-dev-item sp-dev-pending">
          <span class="sp-dev-ico sp-spin">${i.spinner}</span>
          <span class="sp-dev-txt"><b>${this.esc(this.config.localPlayerName)}</b>
            <i>${this.translate("LOCAL_LOADING")}</i></span>
          <span class="sp-dev-state"></span>
        </li>`);
      } else if (this.localStatus === "error") {
        rows.push(`<li class="sp-dev-item sp-dev-err" data-act="retry-local">
          <span class="sp-dev-ico">${i.warn}</span>
          <span class="sp-dev-txt"><b>${this.esc(this.config.localPlayerName)}</b>
            <i>${this.esc(this.localError || this.translate("LOCAL_ERROR"))}</i></span>
          <span class="sp-dev-state"></span>
        </li>`);
      }
    }

    /* --- Appareils Spotify Connect --- */
    this.devices.forEach((d) => {
      const isMe = this.localDeviceId && d.id === this.localDeviceId;
      rows.push(this.deviceRow(d, activeId, isMe));
    });

    this.els.devList.innerHTML = rows.length
      ? rows.join("")
      : `<li class="sp-dev-empty">${this.translate("NO_DEVICE_FOUND")}</li>`;

    /* --- Pied de panneau : aide contextuelle --- */
    if (this.els.devFoot) {
      let hint = "";
      if (this.config.localPlayer && this.localStatus === "error") {
        hint = this.translate("LOCAL_HINT");
      } else if (!this.config.localPlayer) {
        hint = this.translate("DEVICE_HINT");
      }
      this.els.devFoot.innerHTML = hint ? `<span>${hint}</span>` : "";
      this.els.devFoot.style.display = hint ? "block" : "none";
    }
  },

  deviceRow(d, activeId, isMe) {
    const i = this.icons();
    const active = d.is_active || d.id === activeId;
    const sub = isMe ? this.translate("THIS_SCREEN") : (d.type || "");
    return `<li class="sp-dev-item${active ? " on" : ""}${isMe ? " me" : ""}" data-dev="${d.id}">
      <span class="sp-dev-ico">${this.deviceIcon(d.type, isMe)}</span>
      <span class="sp-dev-txt"><b>${this.esc(d.name)}</b><i>${this.esc(sub)}</i></span>
      <span class="sp-dev-state">${active ? i.check : ""}</span>
    </li>`;
  },

  /** Bascule la lecture sur cet écran (si le lecteur local est prêt) */
  playHere() {
    if (this.localDeviceId) {
      this.unlockAudio();
      this.act("transfer", { id: this.localDeviceId, play: true });
    } else {
      Log.warn("[MMM-SpotifyPlayer] lecteur local non disponible");
    }
  },

  /* ==================================================================
     Lecteur local (Spotify Web Playback SDK)
     ================================================================== */
  initLocalPlayer(token) {
    this._token = token;
    if (!this.config.localPlayer) return;

    /* Le player existe déjà : le token est simplement mis à jour ci-dessus */
    if (this._player || this._sdkLoading) return;

    /* Vérification préalable : EME/Widevine disponible ? */
    if (!window.navigator.requestMediaKeySystemAccess) {
      this.localStatus = "error";
      this.localError = this.translate("LOCAL_NO_DRM");
      Log.error("[MMM-SpotifyPlayer] EME indisponible : lance MagicMirror dans Chrome (npm run server).");
      this.renderDevices();
      return;
    }

    this._sdkLoading = true;
    this.localStatus = "loading";
    this.renderDevices();

    window.onSpotifyWebPlaybackSDKReady = () => this.createLocalPlayer();

    const s = document.createElement("script");
    s.src = "https://sdk.scdn.co/spotify-player.js";
    s.async = true;
    s.onerror = () => {
      this._sdkLoading = false;
      this.localStatus = "error";
      this.localError = this.translate("LOCAL_NO_NET");
      Log.error("[MMM-SpotifyPlayer] SDK Spotify non chargé (réseau ?)");
      this.renderDevices();
    };
    document.head.appendChild(s);

    /* Garde-fou : si rien ne se passe en 20 s */
    clearTimeout(this._sdkTimeout);
    this._sdkTimeout = setTimeout(() => {
      if (this.localStatus === "loading") {
        this.localStatus = "error";
        this.localError = this.translate("LOCAL_TIMEOUT");
        this.renderDevices();
      }
    }, 20000);
  },

  createLocalPlayer() {
    if (typeof Spotify === "undefined" || this._player) return;

    const player = new Spotify.Player({
      name: this.config.localPlayerName,
      getOAuthToken: (cb) => cb(this._token),
      volume: this.config.localPlayerVolume
    });
    this._player = player;

    player.addListener("ready", ({ device_id }) => {
      clearTimeout(this._sdkTimeout);
      this.localDeviceId = device_id;
      this.localStatus = "ready";
      this.localError = "";
      Log.info("[MMM-SpotifyPlayer] Lecteur local prêt :", device_id);
      this.renderDevices();
      this.act("devices");
      if (this.config.localPlayerAutoConnect) {
        setTimeout(() => this.act("transfer", { id: device_id, play: false }), 600);
      }
    });

    player.addListener("not_ready", ({ device_id }) => {
      Log.warn("[MMM-SpotifyPlayer] lecteur local hors ligne :", device_id);
      this.localStatus = "loading";
      this.renderDevices();
    });

    player.addListener("initialization_error", ({ message }) => {
      clearTimeout(this._sdkTimeout);
      this.localStatus = "error";
      this.localError = this.translate("LOCAL_NO_DRM");
      Log.error("[MMM-SpotifyPlayer] initialization_error :", message);
      this.renderDevices();
    });

    player.addListener("authentication_error", ({ message }) => {
      clearTimeout(this._sdkTimeout);
      this.localStatus = "error";
      this.localError = this.translate("LOCAL_AUTH");
      Log.error("[MMM-SpotifyPlayer] authentication_error :", message);
      this.renderDevices();
    });

    player.addListener("account_error", ({ message }) => {
      clearTimeout(this._sdkTimeout);
      this.localStatus = "error";
      this.localError = this.translate("LOCAL_PREMIUM");
      Log.error("[MMM-SpotifyPlayer] account_error :", message);
      this.renderDevices();
    });

    player.addListener("playback_error", ({ message }) =>
      Log.warn("[MMM-SpotifyPlayer] playback_error :", message));

    player.connect().then((ok) => {
      if (!ok) {
        this.localStatus = "error";
        this.localError = this.translate("LOCAL_ERROR");
        this.renderDevices();
      }
    });
  },

  /** Autorise la sortie audio (politique autoplay des navigateurs) */
  unlockAudio() {
    if (this.audioUnlocked || !this._player) return;
    if (typeof this._player.activateElement === "function") {
      this._player.activateElement()
        .then(() => { this.audioUnlocked = true; })
        .catch(() => {});
    } else {
      this.audioUnlocked = true;
    }
  },

  retryLocalPlayer() {
    this._sdkLoading = false;
    this._player = null;
    this.localDeviceId = null;
    this.localStatus = "loading";
    this.localError = "";
    this.renderDevices();
    if (typeof Spotify !== "undefined") this.createLocalPlayer();
    else this.initLocalPlayer(this._token);
  },

  /* ==================================================================
     Rendu
     ================================================================== */
  render() {
    if (!this.dom) return;
    const s = this.state;
    const e = this.els;

    if (this.errorCode) {
      e.overlay.classList.add("on");
      e.overlayMsg.textContent = this.translate(this.errorCode);
    } else if (!s) {
      e.overlay.classList.add("on");
      e.overlayMsg.textContent = this.translate("IDLE");
    } else {
      e.overlay.classList.remove("on");
    }

    this.dom.classList.toggle("sp-idle", !s);
    if (!s) {
      if (this.devOpen) this.renderDevices();
      return;
    }

    let changed = false;
    if (e.title.textContent !== s.title) { e.title.textContent = s.title; changed = true; }
    const sub = this.config.showDevice && s.device ? `${s.artist} · ${s.device}` : s.artist;
    if (e.artist.textContent !== sub) { e.artist.textContent = sub; changed = true; }
    if (changed) this.refitAll();

    this.renderProgress();
    this.renderPlayButton();
    this.renderToggles();
    this.renderVolume();

    if (e.devBtn) {
      const onMirror = this.localDeviceId && s.deviceId === this.localDeviceId;
      e.devBtn.classList.toggle("on", !!onMirror);
    }
    if (this.devOpen) this.renderDevices();
  },

  renderProgress() {
    if (!this.state) return;
    const { progress, duration } = this.local;
    const pct = duration ? Math.max(0, Math.min(100, (progress / duration) * 100)) : 0;
    this.els.fill.style.width = pct + "%";
    this.els.elapsed.textContent = this.fmt(progress);
    this.els.duration.textContent = this.fmt(duration);
  },

  renderPlayButton() {
    const i = this.icons();
    this.els.play.innerHTML = this.local.playing ? i.pause : i.play;
    this.els.wrapper.classList.toggle("sp-playing", this.local.playing);
  },

  renderToggles() {
    const s = this.state;
    if (!s) return;
    if (this.els.shuffle) this.els.shuffle.classList.toggle("on", !!s.shuffle);
    if (this.els.repeat) {
      this.els.repeat.classList.toggle("on", s.repeat !== "off");
      this.els.repeat.classList.toggle("track", s.repeat === "track");
    }
    if (this.els.like) this.els.like.classList.toggle("on", !!s.liked);
  },

  renderVolume() {
    if (!this.config.showVolume || !this.state) return;
    const v = this.state.volume;
    this.els.vol.style.opacity = v === null ? 0.3 : 1;
    this.els.volFill.style.width = (v == null ? 0 : v) + "%";
  },

  renderQueue() {
    if (!this.config.showQueue || !this.els) return;
    const list = this.queue.slice(0, this.config.queueLength);
    this.els.queue.style.visibility = list.length ? "visible" : "hidden";
    this.els.queueList.innerHTML = list.map((t) => `<li>
        <span class="sp-q-art">${t.art ? `<img src="${this.proxy(t.art)}" alt="">` : ""}</span>
        <span class="sp-q-txt"><b>${this.esc(t.title)}</b><i>${this.esc(t.artist)}</i></span>
      </li>`).join("");
  },

  /* ==================================================================
     Pochette + couleur dominante
     ================================================================== */
  proxy(url) {
    return "/MMM-SpotifyPlayer/art?u=" + encodeURIComponent(url);
  },

  applyArtwork(url) {
    if (url === this.artUrl) return;
    this.artUrl = url;
    const src = this.proxy(url);
    const img = this.els.art;
    img.classList.remove("ready");
    img.onload = () => {
      img.classList.add("ready");
      if (this.els.bgArt) this.els.bgArt.style.backgroundImage = `url("${src}")`;
      if (this.config.accentFromArtwork) this.applyPalette(this.extractPalette(img));
    };
    img.src = src;
  },

  extractPalette(img) {
    try {
      const N = 44;
      const c = document.createElement("canvas");
      c.width = c.height = N;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, N, N);
      const d = ctx.getImageData(0, 0, N, N).data;
      const buckets = new Map();

      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (d[i + 3] < 128) continue;
        const [h, s, l] = this.rgb2hsl(r, g, b);
        if (l < 0.07 || l > 0.95) continue;
        const key = `${Math.round(h * 16)}|${Math.round(s * 3)}`;
        const w = (0.25 + s) * (1 - Math.abs(l - 0.55) * 1.1);
        const o = buckets.get(key) || { w: 0, r: 0, g: 0, b: 0, n: 0 };
        o.w += w; o.r += r; o.g += g; o.b += b; o.n++;
        buckets.set(key, o);
      }
      let best = null;
      buckets.forEach((v) => { if (!best || v.w > best.w) best = v; });
      if (!best) return null;
      return [best.r / best.n, best.g / best.n, best.b / best.n].map(Math.round);
    } catch {
      return null;
    }
  },

  applyPalette(rgb) {
    const root = this.dom;
    if (!rgb) {
      ["--sp-bg1", "--sp-bg2", "--sp-glow"].forEach((p) => root.style.removeProperty(p));
      root.style.setProperty("--sp-accent", this.config.fallbackAccent);
      return;
    }
    let [h, s] = this.rgb2hsl(rgb[0], rgb[1], rgb[2]);
    s = Math.min(1, Math.max(0.35, s));
    root.style.setProperty("--sp-accent", this.hsl2css(h, s, 0.58));
    root.style.setProperty("--sp-bg1",    this.hsl2css(h, Math.min(0.6, s * 0.75), 0.13));
    root.style.setProperty("--sp-bg2",    this.hsl2css(h, Math.min(0.5, s * 0.6), 0.045));
    root.style.setProperty("--sp-glow",   this.hsl2css(h, s, 0.45, 0.45));
  },

  /* ==================================================================
     Utilitaires
     ================================================================== */
  rgb2hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  },

  hsl2css(h, s, l, a) {
    const H = Math.round(h * 360), S = Math.round(s * 100), L = Math.round(l * 100);
    return a === undefined ? `hsl(${H} ${S}% ${L}%)` : `hsla(${H} ${S}% ${L}% / ${a})`;
  },

  fmt(ms) {
    if (!ms || ms < 0) ms = 0;
    const t = Math.floor(ms / 1000);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  },

  esc(s) {
    return String(s == null ? "" : s)
      .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
});