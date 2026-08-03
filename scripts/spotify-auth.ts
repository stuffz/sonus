/**
 * One-time Spotify OAuth setup script.
 *
 * This starts a tiny local server, opens the Spotify OAuth page in your browser,
 * and exchanges the auth code for a refresh token. Add the refresh token to your .env.
 *
 * Prerequisites:
 *   1. Create a Spotify app at https://developer.spotify.com/dashboard
 *   2. Add http://127.0.0.1:8888/callback as a Redirect URI in app settings
 *   3. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your .env
 *
 * Usage:
 *   npx tsx scripts/spotify-auth.ts
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { createServer } from "http";
import { URL } from "url";

// Load .env
const envPath = resolve(import.meta.dirname, "../.env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Error: SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in .env");
  process.exit(1);
}

const REDIRECT_URI = "http://127.0.0.1:8888/callback";
const SCOPES = "playlist-read-private playlist-read-collaborative";

const authUrl = new URL("https://accounts.spotify.com/authorize");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("scope", SCOPES);

console.log("\n--- Spotify OAuth Setup ---\n");
console.log("1. Make sure http://127.0.0.1:8888/callback is added as a Redirect URI");
console.log("   in your Spotify app settings at https://developer.spotify.com/dashboard\n");
console.log("2. Open this URL in your browser:\n");
console.log(`   ${authUrl.toString()}\n`);

// Try to open the URL automatically
try {
  const { exec } = await import("child_process");
  const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  exec(`${cmd} "${authUrl.toString().replace(/&/g, "^&")}"`);
  console.log("   (Attempting to open automatically...)\n");
} catch {
  /* ignore */
}

console.log("Waiting for callback on port 8888...\n");

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith("/callback")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const url = new URL(req.url, "http://127.0.0.1:8888");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h2>Authorization denied</h2><p>${error}</p><p>You can close this tab.</p>`);
    console.error(`Authorization denied: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h2>Missing authorization code</h2><p>You can close this tab.</p>");
    return;
  }

  // Exchange code for tokens
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  try {
    const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
    });

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text();
      throw new Error(`Token exchange failed (${tokenResponse.status}): ${text}`);
    }

    const data = (await tokenResponse.json()) as { access_token: string; refresh_token: string; expires_in: number };

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>Success!</h2><p>You can close this tab and check the terminal.</p>");

    console.log("✓ Authorization successful!\n");
    console.log("Add this to your .env file:\n");
    console.log(`SPOTIFY_REFRESH_TOKEN=${data.refresh_token}\n`);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(`<h2>Error</h2><p>${err instanceof Error ? err.message : err}</p>`);
    console.error("Error:", err);
  }

  server.close();
});

server.listen(8888);
