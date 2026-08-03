import { config } from "../config";

/** Transcribe a WAV buffer via the whisper (speaches) server. Returns the recognized text. */
export async function transcribe(wav: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
  form.append("model", config.WHISPER_MODEL);
  form.append("response_format", "json");

  const res = await fetch(`${config.WHISPER_URL}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`whisper error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.text ?? "").trim();
}
