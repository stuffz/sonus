# Patches

Applied automatically by [`patch-package`](https://github.com/ds300/patch-package) during `npm install` (`postinstall`). In Docker this happens at **build time**, so changing a patch requires a full rebuild: `docker compose up -d --build`.

## `@distube+yt-dlp+2.0.1.patch`

Hardens how the plugin invokes yt-dlp:

- **Split stdout/stderr** — upstream concatenates both streams and `JSON.parse`s the result, so any yt-dlp warning corrupts the JSON. The patch parses stdout only and surfaces stderr in error messages.
- **`jsRuntimes: "node"`** — required for yt-dlp's EJS challenge solver to handle YouTube's sig/n token challenges. Without it, only storyboard images are returned (no audio/video formats). Do not remove.
- **`cookies: process.env.YTDLP_COOKIES`** — optional cookies file for authenticated requests (age-restricted videos, higher rate limits). Set automatically by `src/lib/music/ytdlp.ts` when `data/cookies.txt` exists. Stale cookies cause UNPLAYABLE errors — re-export from an incognito window if that happens.
- **`retries: 3`, `bufferSize: "16K"`, `httpChunkSize: "10M"`** — extraction/download robustness.

The `dargs` library converts the camelCase keys to kebab-case CLI flags (`jsRuntimes` → `--js-runtimes`).

## `distube+5.2.3.patch`

Creates the discord.js audio player with `maxMissedFrames: 250` (default 5, i.e. ~100 ms). Brief network hiccups or slow stream starts no longer end playback — up to ~5 s of missed frames is tolerated.

## yt-dlp updates

The yt-dlp binary self-updates via its native `--update` mechanism (not the plugin's buggy `downloadYtDlp()`): once on startup and every 24 h via cron. See `src/lib/music/ytdlp.ts`.
