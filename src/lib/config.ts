const { DISCORD_TOKEN } = process.env;

if (!DISCORD_TOKEN) {
  throw new Error("Missing DISCORD_TOKEN environment variable");
}

export const config = {
  DISCORD_TOKEN,
  HEALTH_PORT: parseInt(process.env.HEALTH_PORT || "3000", 10),
  ADMIN_IDS: (process.env.ADMIN_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
  PRESENCE_TYPE: process.env.PRESENCE_TYPE || "Playing",
  PRESENCE_TEXT: process.env.PRESENCE_TEXT || "/help",
  OLLAMA_API_URL: process.env.OLLAMA_API_URL || "",
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || "",
  SEARXNG_URL: process.env.SEARXNG_URL || "http://host.docker.internal:9072",
  // Voice pipeline (self-hosted, CPU): STT (whisper) + TTS (piper)
  WHISPER_URL: process.env.WHISPER_URL || "http://host.docker.internal:9069",
  WHISPER_MODEL: process.env.WHISPER_MODEL || "Systran/faster-whisper-small",
  TTS_URL: process.env.TTS_URL || "http://host.docker.internal:9070",
  TTS_VOICE: process.env.TTS_VOICE || "alloy",
  SPOTIFY_CLIENT_ID: process.env.SPOTIFY_CLIENT_ID || "",
  SPOTIFY_CLIENT_SECRET: process.env.SPOTIFY_CLIENT_SECRET || "",
  SPOTIFY_REFRESH_TOKEN: process.env.SPOTIFY_REFRESH_TOKEN || "",
};
