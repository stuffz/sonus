import { config } from "../config";

/** Synthesize speech (WAV buffer) from text via the openedai-speech (Piper) server. */
export async function synthesize(text: string): Promise<Buffer> {
  const res = await fetch(`${config.TTS_URL}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "tts-1",
      voice: config.TTS_VOICE,
      input: text,
      response_format: "wav",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`tts error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
