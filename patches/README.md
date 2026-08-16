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

Patches **both** `dist/index.js` (CJS) and `dist/index.mjs` (ESM). This app is
`"type": "module"`, so Node resolves distube's `import` export condition and loads
`index.mjs` — an earlier version of this patch only touched `index.js`, so its
`maxMissedFrames` change never actually ran. Keep the two files in sync.

- **`maxMissedFrames: 250`** on the discord.js audio player (default 5, i.e. ~100 ms).
  Brief network hiccups or slow stream starts no longer end playback — up to ~5 s of
  missed frames is tolerated.
- **Retry a stream that dies before playback** (`#handlePlayingError`). YouTube serves
  media URLs bound to a server-side experiment bucket (visible as the `fexp` value
  `51946838`). URLs in the bad bucket reject ffmpeg's open-ended `Range: bytes=0-`
  with HTTP 403 before a single byte of audio decodes; they only ever serve the first
  ~900 KB, and the rest needs SABR, which yt-dlp can't do for the `ANDROID_VR` client
  (the only client still returning audio — `web`/`ios`/`mweb` are PO-token gated and
  `tv` is DRM'd). Measured 50/50 good/bad over 20 extractions on 2026-08-15.

  The bucket is re-rolled on **every** extraction, so the recovery is to drop the
  cached `song.stream.url` (`attachStreamInfo` early-returns when it's set) and
  re-resolve — up to 5 times. Guarded on `queue.currentTime < 5` so a failure
  *mid-song* still falls through to the normal skip-to-next behaviour, and on
  `errorCode === "FFMPEG_EXITED"` so unrelated errors are untouched. Retries emit no
  `PLAY_SONG`, so users see one "now playing" embed and, if all 5 fail, one error.
  Counters reset in `handleSongFinish`.

- **Ignore the stray `finish` that accompanies a dead stream** (`handleSongFinish`).
  A stream that 403s before playback also drives the audio player Idle, so distube
  emits `finish` *alongside* `error`. Upstream never noticed because
  `#handlePlayingError` always shifted the song and stopped the queue; once the retry
  returns early instead, that stray `finish` arrives mid-retry and tears the queue
  down (observed in production 2026-08-16 00:12: "Handling song finish" → "Queue is
  empty, stopping..." one millisecond after a retry started). The `_streamRetrying`
  flag is held across the replay so the finish is dropped. If `finish` happens to land
  *before* `error`, the `!queue.stopped` guard makes the retry a no-op and behaviour
  degrades to upstream's — never worse.

  Remove this once yt-dlp gains SABR support for `ANDROID_VR`, or YouTube drops the
  experiment.

## yt-dlp updates

The yt-dlp binary self-updates via its native `--update` mechanism (not the plugin's buggy `downloadYtDlp()`): once on startup and every 24 h via cron. See `src/lib/music/ytdlp.ts`.
