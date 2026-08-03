import { spawn } from "child_process";
import ffmpegStatic from "ffmpeg-static";

const ffmpegPath = (ffmpegStatic as unknown as string) || "ffmpeg";

// Discord voice-receive PCM format: 48 kHz, 16-bit, stereo.
export const DISCORD_SAMPLE_RATE = 48_000;
export const DISCORD_CHANNELS = 2;
export const DISCORD_BYTES_PER_SAMPLE = 2;
// Bytes of PCM per millisecond of audio (48000 * 2ch * 2bytes / 1000).
export const PCM_BYTES_PER_MS = (DISCORD_SAMPLE_RATE * DISCORD_CHANNELS * DISCORD_BYTES_PER_SAMPLE) / 1000;

/** Duration (ms) of a raw Discord PCM buffer. */
export function pcmDurationMs(pcm: Buffer): number {
  return pcm.length / PCM_BYTES_PER_MS;
}

/**
 * Convert raw 48 kHz stereo s16le PCM (as received from Discord) into a 16 kHz mono WAV
 * buffer suitable for whisper. Uses the bundled ffmpeg-static binary.
 */
export function pcmToWav(pcm: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      String(DISCORD_SAMPLE_RATE),
      "-ac",
      String(DISCORD_CHANNELS),
      "-i",
      "pipe:0",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-f",
      "wav",
      "pipe:1",
    ]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout.on("data", (d) => out.push(d));
    ff.stderr.on("data", (d) => err.push(d));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`));
    });
    ff.stdin.on("error", () => {
      /* ignore EPIPE if ffmpeg dies early */
    });
    ff.stdin.end(pcm);
  });
}
