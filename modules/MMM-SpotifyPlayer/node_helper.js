const NodeHelper = require("node_helper");
const Log = require("logger");
const fs = require("fs");
const path = require("path");
const https = require("https");

const API = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

module.exports = NodeHelper.create({
  start() {
    this.config = null;
    this.creds = null;
    this.tokens = null;
    this.inFlight = false;
    this.rateLimitUntil = 0;
    this.lastTrackId = null;
    this.timer = null;
    this.queueTimer = null;
    this.tokenTimer = null;
    this.devices = [];
    this.preferredDone = false;
    this.tokenPath = path.join(__dirname, "token.json");
    this.credPath = path.join(__dirname, "credentials.json");
    this.setupRoutes();
    Log.info("[MMM-SpotifyPlayer] helper started");
  },

  /* ================================================================
     Proxy image (CORS pour l'extraction de couleur)
     ================================================================ */
  setupRoutes() {
    this.expressApp.get("/MMM-SpotifyPlayer/art", (req, res) => {
      let url;
      try {
        url = new URL(req.query.u);
      } catch {
        return res.sendStatus(400);
      }
      const ok = /(^|\.)(scdn\.co|spotifycdn\.com)$/.test(url.hostname);
      if (!ok || url.protocol !== "https:") return res.sendStatus(403);

      https
        .get(url, (r) => {
          res.set("Content-Type", r.headers["content-type"] || "image/jpeg");
          res.set("Cache-Control", "public, max-age=86400");
          res.set("Access-Control-Allow-Origin", "*");
          r.pipe(res);
        })
        .on("error", () => res.sendStatus(502));
    });
  },

  /* ================================================================
     Sockets
     ================================================================ */
  socketNotificationReceived(notification, payload) {
    switch (notification) {
      case "SP_CONFIG":
        if (this.config) {
          // Nouveau client (rechargement de page) : on lui renvoie ce qu'il faut
          if (this.config.localPlayer) this.pushToken();
          this.listDevices();
          this.poll();
          return;
        }
        this.config = payload;
        this.loadFiles();
        this.startPolling();
        this.startTokenPush();
        break;

      case "SP_ACTION":
        this.doAction(payload).catch((e) => this.err(e));
        break;

      case "SP_REFRESH":
        this.poll();
        break;
    }
  },

  loadFiles() {
    try {
      this.creds = JSON.parse(fs.readFileSync(this.credPath, "utf8"));
    } catch {
      this.creds = null;
    }
    try {
      this.tokens = JSON.parse(fs.readFileSync(this.tokenPath, "utf8"));
    } catch {
      this.tokens = null;
    }

    /* Avertissement si le scope "streaming" manque */
    if (this.config && this.config.localPlayer && this.tokens && this.tokens.scope) {
      if (!/\bstreaming\b/.test(this.tokens.scope)) {
        Log.error(
          "[MMM-SpotifyPlayer] Le scope 'streaming' est absent de token.json.\n" +
          "  -> supprime token.json puis relance : node auth.js"
        );
      }
    }
  },

  startPolling() {
    clearInterval(this.timer);
    clearInterval(this.queueTimer);
    this.poll();
    this.listDevices();
    this.timer = setInterval(() => this.poll(), this.config.updateInterval);
    if (this.config.showQueue) {
      this.fetchQueue();
      this.queueTimer = setInterval(() => this.fetchQueue(), this.config.queueInterval);
    }
    if (this.config.preferredDevice) {
      setTimeout(() => this.selectPreferredDevice(), 5000);
    }
  },

  startTokenPush() {
    if (!this.config.localPlayer) return;
    clearInterval(this.tokenTimer);
    this.pushToken();
    this.tokenTimer = setInterval(() => this.pushToken(), 30 * 60 * 1000);
  },

  async pushToken() {
    try {
      const t = await this.getToken();
      if (t) this.sendSocketNotification("SP_TOKEN", t);
    } catch (e) {
      this.err(e);
    }
  },

  /* ================================================================
     Auth
     ================================================================ */
  async getToken() {
    if (!this.creds) throw Object.assign(new Error("NO_CREDENTIALS"), { code: "NO_CREDENTIALS" });
    if (!this.tokens) throw Object.assign(new Error("NO_TOKEN"), { code: "NO_TOKEN" });
    if (Date.now() < (this.tokens.expires_at || 0) - 30000) return this.tokens.access_token;
    return this.refresh();
  },

  async refresh() {
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString("base64")
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.tokens.refresh_token
      })
    });
    const data = await r.json();
    if (!r.ok) throw Object.assign(new Error("REFRESH_FAILED"), { code: "NO_TOKEN" });
    this.tokens = {
      ...this.tokens,
      ...data,
      expires_at: Date.now() + data.expires_in * 1000
    };
    fs.writeFileSync(this.tokenPath, JSON.stringify(this.tokens, null, 2));

    if (this.config && this.config.localPlayer) {
      this.sendSocketNotification("SP_TOKEN", this.tokens.access_token);
    }
    return this.tokens.access_token;
  },

  /* ================================================================
     Wrapper API
     ================================================================ */
  async api(method, endpoint, { query, body, retry = true } = {}) {
    const token = await this.getToken();
    const url = new URL(API + endpoint);
    if (query)
      Object.entries(query).forEach(([k, v]) => v !== undefined && url.searchParams.set(k, v));

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (res.status === 401 && retry) {
      await this.refresh();
      return this.api(method, endpoint, { query, body, retry: false });
    }
    if (res.status === 429) {
      const ra = parseInt(res.headers.get("retry-after") || "5", 10);
      this.rateLimitUntil = Date.now() + (ra + 1) * 1000;
      throw Object.assign(new Error("RATE_LIMIT"), { code: "RATE_LIMIT" });
    }
    if (res.status === 204 || res.status === 202) return null;
    if (!res.ok) {
      const txt = await res.text();
      throw Object.assign(new Error(`${res.status} ${txt}`), { code: String(res.status) });
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("json") ? res.json() : null;
  },

  err(e) {
    this.sendSocketNotification("SP_ERROR", { code: e.code || "ERROR", message: e.message });
  },

  /* ================================================================
     État de lecture
     ================================================================ */
  async poll() {
    if (this.inFlight || Date.now() < this.rateLimitUntil) return;
    this.inFlight = true;
    try {
      const s = await this.api("GET", "/me/player", {
        query: { additional_types: "track,episode" }
      });

      if (!s || !s.item) {
        this.lastTrackId = null;
        return this.sendSocketNotification("SP_STATE", { active: false });
      }

      const item = s.item;
      const isTrack = item.type === "track";
      const trackId = item.id;

      let liked = null;
      if (this.config.showLike && isTrack && trackId && trackId !== this.lastTrackId) {
        try {
          const c = await this.api("GET", "/me/tracks/contains", { query: { ids: trackId } });
          liked = Array.isArray(c) ? c[0] : null;
        } catch {
          /* scope manquant */
        }
      }

      const payload = {
        active: true,
        id: trackId,
        type: item.type,
        title: item.name,
        artist: isTrack
          ? item.artists.map((a) => a.name).join(", ")
          : item.show?.name || "",
        album: isTrack ? item.album?.name : "",
        art:
          (isTrack ? item.album?.images : item.images)?.sort((a, b) => b.width - a.width)?.[0]
            ?.url || null,
        duration: item.duration_ms,
        progress: s.progress_ms || 0,
        playing: !!s.is_playing,
        shuffle: !!s.shuffle_state,
        repeat: s.repeat_state,
        volume: s.device?.volume_percent ?? null,
        supportsVolume: !!s.device?.supports_volume,
        device: s.device?.name || "",
        deviceId: s.device?.id || null,
        deviceType: s.device?.type || "",
        liked,
        ts: Date.now()
      };

      if (trackId !== this.lastTrackId) {
        this.lastTrackId = trackId;
        if (this.config.showQueue) setTimeout(() => this.fetchQueue(), 800);
      }
      this.sendSocketNotification("SP_STATE", payload);
    } catch (e) {
      this.err(e);
    } finally {
      this.inFlight = false;
    }
  },

  async fetchQueue() {
    if (Date.now() < this.rateLimitUntil) return;
    try {
      const q = await this.api("GET", "/me/player/queue");
      if (!q) return;
      const list = (q.queue || []).slice(0, 8).map((i) => ({
        id: i.id,
        title: i.name,
        artist: (i.artists || []).map((a) => a.name).join(", ") || i.show?.name || "",
        art:
          (i.album?.images || i.images || []).sort((a, b) => a.width - b.width)?.[0]?.url || null
      }));
      this.sendSocketNotification("SP_QUEUE", list);
    } catch (e) {
      /* silencieux */
    }
  },

  /* ================================================================
     Appareils
     ================================================================ */
  async listDevices(silent = false) {
    if (Date.now() < this.rateLimitUntil) return this.devices;
    try {
      const d = await this.api("GET", "/me/player/devices");
      this.devices = d?.devices || [];
      if (!silent) this.sendSocketNotification("SP_DEVICES", this.devices);
      return this.devices;
    } catch (e) {
      if (!silent) this.err(e);
      return this.devices;
    }
  },

  async transferTo(deviceId, play) {
    if (!deviceId) throw Object.assign(new Error("NO_DEVICE"), { code: "NO_DEVICE" });
    await this.api("PUT", "/me/player", { body: { device_ids: [deviceId], play: !!play } });

    setTimeout(() => this.poll(), 700);
    setTimeout(() => {
      this.poll();
      this.listDevices();
    }, 2000);
  },

  async selectPreferredDevice() {
    if (this.preferredDone) return;
    try {
      const devs = await this.listDevices(true);
      const want = String(this.config.preferredDevice).toLowerCase();
      const target = devs.find((d) => d.name.toLowerCase() === want);
      if (!target) {
        Log.warn(`[MMM-SpotifyPlayer] appareil "${this.config.preferredDevice}" introuvable`);
        return;
      }
      this.preferredDone = true;
      if (!target.is_active) {
        Log.info("[MMM-SpotifyPlayer] transfert vers", target.name);
        await this.transferTo(target.id, false);
      }
    } catch (e) {
      Log.warn("[MMM-SpotifyPlayer] preferredDevice :", e.message);
    }
  },

  async ensureDevice() {
    const devices = await this.listDevices(true);
    if (!devices.length) throw Object.assign(new Error("NO_DEVICE"), { code: "NO_DEVICE" });
    let target = devices.find((x) => x.is_active);
    if (!target && this.config.preferredDevice)
      target = devices.find(
        (x) => x.name.toLowerCase() === String(this.config.preferredDevice).toLowerCase()
      );
    if (!target) target = devices[0];
    if (!target.is_active)
      await this.api("PUT", "/me/player", { body: { device_ids: [target.id], play: false } });
    return target.id;
  },

  /* ================================================================
     Actions
     ================================================================ */
  async doAction({ action, value }) {
    try {
      switch (action) {
        case "play":
          await this.ensureDevice();
          await this.api("PUT", "/me/player/play");
          break;
        case "pause":
          await this.api("PUT", "/me/player/pause");
          break;
        case "next":
          await this.api("POST", "/me/player/next");
          break;
        case "previous":
          await this.api("POST", "/me/player/previous");
          break;
        case "seek":
          await this.api("PUT", "/me/player/seek", { query: { position_ms: Math.round(value) } });
          break;
        case "volume":
          await this.api("PUT", "/me/player/volume", {
            query: { volume_percent: Math.max(0, Math.min(100, Math.round(value))) }
          });
          break;
        case "shuffle":
          await this.api("PUT", "/me/player/shuffle", { query: { state: !!value } });
          break;
        case "repeat":
          await this.api("PUT", "/me/player/repeat", { query: { state: value } });
          break;
        case "like":
          await this.api(value.liked ? "PUT" : "DELETE", "/me/tracks", { query: { ids: value.id } });
          this.lastTrackId = null;
          break;

        case "devices":
          await this.listDevices();
          return;

        case "transfer": {
          let id = value?.id;
          if (!id && value?.name) {
            const devs = await this.listDevices(true);
            const t = devs.find(
              (d) => d.name.toLowerCase() === String(value.name).toLowerCase()
            );
            id = t?.id || null;
          }
          await this.transferTo(id, value?.play);
          return;
        }

        default:
          Log.warn("[MMM-SpotifyPlayer] action inconnue :", action);
          return;
      }
    } catch (e) {
      this.err(e);
    }
    setTimeout(() => this.poll(), 350);
  },

  stop() {
    clearInterval(this.timer);
    clearInterval(this.queueTimer);
    clearInterval(this.tokenTimer);
  }
});