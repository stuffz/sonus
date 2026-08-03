# Sonus

A self-hosted Discord bot built with discord.js: music playback (YouTube/Spotify), reminders, quote commands, and an optional local AI assistant (text chat + voice) backed by your own OpenAI-compatible endpoints.

## Setup

```bash
npm install
cp .env.example .env   # add your Discord token; everything else is optional
```

## Running

```bash
npx tsx src/index.ts   # development
./deploy.sh            # production (Docker): git pull + rebuild + restart
```

## Slash commands

- **Music:** `/play` · `/skip` · `/stop` · `/queue` · `/music`
- **AI assistant:** `/ask` · `/listen` · `/leave` (voice, wake word "Jarvis") — or @mention the bot to chat
- **Utility:** `/remind` · `/reminders` · `/timezone` · `/voicelog` · `/help`
- **Quotes:** auto-generated from `data/quotes/*.json` (e.g. `/8ball`)
- **Admin:** `/status` — requires your user ID in `ADMIN_IDS`

Commands are not deployed on startup. After adding or changing a command:

```bash
npx tsx scripts/deploy-commands.ts
# or in Docker:
docker compose exec sonus-bot npx tsx scripts/deploy-commands.ts
```

`npx tsx scripts/clear-commands.ts` removes all registered commands.

## AI assistant (optional)

Chat (@mention), `/ask`, and voice (`/listen`) use self-hosted OpenAI-compatible services: an LLM (`OLLAMA_API_URL`), Whisper STT (`WHISPER_URL`), TTS (`TTS_URL`), and SearXNG web search (`SEARXNG_URL`). See `.env.example`. AI features stay disabled until configured.

## YouTube cookies (optional)

For age-restricted videos and higher rate limits, export your YouTube cookies to `data/cookies.txt` (e.g. with a cookies.txt browser extension). Auto-detected on startup.

## Spotify (optional)

- Track links work out of the box (converted to a YouTube search via [idonthavespotify](https://idonthavespotify.sjdonado.com/)).
- Playlists (used as background playlists) need Spotify API credentials: set them in `.env` (see `.env.example`), then run `npx tsx scripts/spotify-auth.ts`.

## Dashboard & API

A live dashboard (`http://<host>:3000/`) and JSON API are served on `HEALTH_PORT` (default 3000): `GET /api/status`, `GET /api/guilds[/:id]`, an SSE stream at `/api/events`, and POST endpoints for feature toggles and music controls. **There is no auth — keep the port LAN-only.**
