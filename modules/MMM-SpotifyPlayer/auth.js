/* Usage : cd modules/MMM-SpotifyPlayer && node auth.js */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CRED = path.join(__dirname, "credentials.json");
if (!fs.existsSync(CRED)) {
  console.error("❌ credentials.json manquant dans " + __dirname);
  process.exit(1);
}
const creds = JSON.parse(fs.readFileSync(CRED, "utf8"));
const redirectUri = creds.redirectUri || "http://127.0.0.1:8888/callback";
const u = new URL(redirectUri);
const port = u.port || 8888;

const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-library-read",
  "user-library-modify",
  /* Indispensables pour lire DANS le navigateur (Web Playback SDK) */
  "streaming",
  "user-read-email",
  "user-read-private"
].join(" ");

const state = crypto.randomBytes(8).toString("hex");
const authUrl =
  "https://accounts.spotify.com/authorize?" +
  new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
    show_dialog: "true"
  });

console.log("\n👉 Ouvre cette URL dans un navigateur :\n");
console.log(authUrl + "\n");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname !== u.pathname) return res.end("…");

  const code = url.searchParams.get("code");
  if (!code || url.searchParams.get("state") !== state) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    return res.end("<h1>Échec de l'autorisation</h1>");
  }

  try {
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri
      })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(data));

    data.expires_at = Date.now() + data.expires_in * 1000;
    fs.writeFileSync(path.join(__dirname, "token.json"), JSON.stringify(data, null, 2));

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<body style="background:#0b0f18;color:#fff;font-family:sans-serif;display:grid;place-items:center;height:100vh">
        <div><h1>✅ Compte lié !</h1><p>Tu peux fermer cet onglet et redémarrer MagicMirror.</p></div>
      </body>`
    );
    console.log("✅ token.json créé.");
    console.log("   Scopes :", data.scope || SCOPES);
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    res.writeHead(500).end("Erreur : " + e.message);
    console.error(e);
  }
});

server.listen(port, "0.0.0.0", () =>
  console.log(`⏳ En attente du callback sur le port ${port}…`)
);