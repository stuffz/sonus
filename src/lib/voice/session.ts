import { Readable } from "stream";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  entersState,
} from "@discordjs/voice";
import type { VoiceConnection, AudioPlayer, AudioResource } from "@discordjs/voice";
import prism from "prism-media";
import type { VoiceBasedChannel } from "discord.js";
import { logger } from "../logger";
import { buildVoiceSystemPrompt } from "../ai/llm";
import { runAgent } from "../ai/agent";
import { webSearchTool } from "../ai/tools";
import { getHistory, recordTurn, clearConversation } from "../ai/conversation";
import { isFeatureEnabled } from "../features";
import { PCM_BYTES_PER_MS, pcmDurationMs, pcmToWav } from "./audio";
import { transcribe } from "./stt";
import { synthesize } from "./tts";

// Utterance gate — configurable knobs for the "explicit activation" v1.
const MIN_UTTERANCE_MS = 1_000; // ignore clips shorter than this (taps, coughs, noise)
const MAX_UTTERANCE_MS = 20_000; // ignore clips longer than this (open-mic / non-PTT background)
const SILENCE_END_MS = 1_000; // an utterance is considered finished after this much silence
const MAX_PCM_BYTES = Math.ceil((MAX_UTTERANCE_MS + 2_000) * PCM_BYTES_PER_MS); // hard collection cap

// Instant canned acks (no LLM) played immediately while the real answer is generated —
// fills the dead air since voice has no "typing" indicator. Synthesized once and cached.
const ACK_PHRASES = [
  "On it.",
  "Let me check.",
  "One sec.",
  "Looking into that.",
  "Sure, checking now.",
  "Let me see.",
  "Right away.",
  "Give me a second.",
  "Okay, checking.",
  "Let me find out.",
];
let ackClipsPromise: Promise<Buffer[]> | null = null;
function getAckClips(): Promise<Buffer[]> {
  if (!ackClipsPromise) {
    ackClipsPromise = Promise.all(ACK_PHRASES.map((p) => synthesize(p).catch(() => Buffer.alloc(0)))).then((clips) =>
      clips.filter((b) => b.length > 0),
    );
  }
  return ackClipsPromise;
}

// Fillers played periodically during a long answer so voice never goes silent after the ack.
const FILLER_PHRASES = [
  "Still working on it.",
  "Almost there.",
  "One moment.",
  "Bear with me.",
  "Hang tight.",
  "Just a sec.",
  "Digging into it.",
  "Still on it.",
  "Won't be long.",
  "Nearly done.",
  "Give me a moment.",
  "Still searching.",
];
let fillerClipsPromise: Promise<Buffer[]> | null = null;
function getFillerClips(): Promise<Buffer[]> {
  if (!fillerClipsPromise) {
    fillerClipsPromise = Promise.all(FILLER_PHRASES.map((p) => synthesize(p).catch(() => Buffer.alloc(0)))).then(
      (clips) => clips.filter((b) => b.length > 0),
    );
  }
  return fillerClipsPromise;
}

// Thinking is on by default (correctness); a "quick" request turns it off for speed-over-accuracy.
const QUICK_TRIGGER =
  /\b(quick(ly)?|just quickly|fast answer|don'?t overthink|no need to think|keep it short|tl;?dr)\b/i;

// Wake word: "Jarvis" — a hard-onset, uncommon name that STT transcribes reliably. Only utterances
// addressing the bot by name get answered/remembered (no silent follow-up window — in a live VC
// people keep talking about other things). Explicit spellings + a light "j…" fuzzy fallback.
const WAKE_RE = /\b(hey\s+)?(jarvis|jarviss|jervis|jarvus|jarvish|jarvic|jarvi)\b[.,!?]*/gi;

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

function addressesBot(text: string): { addressed: boolean; cleaned: string } {
  const norm = text.replace(/\s+/g, " ").trim();
  // 1) explicit "Jarvis"/spellings anywhere in the utterance
  const stripped = norm.replace(WAKE_RE, " ").replace(/\s+/g, " ").trim();
  if (stripped !== norm) return { addressed: true, cleaned: stripped };
  // 2) fuzzy: an early "j…" word within edit distance 2 of "jarvis" (guards against non-j false hits)
  const words = norm.split(" ");
  for (let i = 0; i < Math.min(words.length, 3); i++) {
    const w = words[i].toLowerCase().replace(/[^a-z]/g, "");
    if (w.length >= 5 && w.startsWith("j") && levenshtein(w, "jarvis") <= 2) {
      words.splice(i, 1);
      return { addressed: true, cleaned: words.join(" ").trim() };
    }
  }
  return { addressed: false, cleaned: norm };
}

export type SendableTextChannel = { send: (content: string) => Promise<unknown> };

/** One listening session bound to a single guild's voice channel. */
export class VoiceSession {
  readonly guildId: string;
  readonly channelName: string;
  private connection: VoiceConnection;
  private player: AudioPlayer;
  private textChannel?: SendableTextChannel;
  private activeUsers = new Set<string>();
  private displayName: (userId: string) => string;
  private speechQueue: AudioResource[] = []; // ack → answer, played without overlap
  private speaking = false;
  private lastAck?: Buffer;
  private lastFiller?: Buffer;

  constructor(channel: VoiceBasedChannel, textChannel?: SendableTextChannel) {
    this.guildId = channel.guild.id;
    this.channelName = channel.name;
    this.textChannel = textChannel;
    this.displayName = (userId) => channel.guild.members.cache.get(userId)?.displayName ?? userId;

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // MUST be undeafened to receive audio
      selfMute: false,
    });
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.connection.subscribe(this.player);
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.speaking = false;
      this.pump();
    });
    void getAckClips(); // pre-warm ack clips so the first one plays instantly
    void getFillerClips(); // pre-warm filler clips for long answers

    this.connection.receiver.speaking.on("start", (userId) => this.onSpeakingStart(userId));
    this.connection.on(VoiceConnectionStatus.Disconnected, () =>
      logger.info(`[voice] connection disconnected (guild ${this.guildId})`),
    );
  }

  /** Wait until the voice connection is ready (throws on timeout). */
  async awaitReady(): Promise<void> {
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    logger.info(
      `[voice] ✅ listening in "${this.channelName}" (guild ${this.guildId}) — gate ${MIN_UTTERANCE_MS}-${MAX_UTTERANCE_MS}ms, log-everything mode`,
    );
  }

  private onSpeakingStart(userId: string): void {
    if (this.activeUsers.has(userId)) return; // already capturing this user's current utterance
    this.activeUsers.add(userId);
    const name = this.displayName(userId);
    logger.info(`[voice] ⏺ ${name} started speaking`);

    const opusStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_END_MS },
    });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    const chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;

    decoder.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_PCM_BYTES) {
        overflow = true;
        return;
      } // stop collecting; we'll reject it
      chunks.push(chunk);
    });
    decoder.on("error", (e: Error) => logger.warn(`[voice] decoder error (${name}): ${e.message}`));

    opusStream.pipe(decoder);
    opusStream.on("end", () => {
      this.activeUsers.delete(userId);
      void this.handleUtterance(name, Buffer.concat(chunks), overflow);
    });
    opusStream.on("error", (e: Error) => {
      this.activeUsers.delete(userId);
      logger.warn(`[voice] opus stream error (${name}): ${e.message}`);
    });
  }

  private async handleUtterance(name: string, pcm: Buffer, overflow: boolean): Promise<void> {
    // A live session goes quiet the moment an admin toggles Voice AI off (no STT/LLM/TTS).
    if (!isFeatureEnabled("aiVoice")) return;

    const ms = Math.round(pcmDurationMs(pcm));
    logger.info(`[voice] ⏹ ${name} finished: ${pcm.length} bytes (~${ms}ms)`);

    if (overflow || ms > MAX_UTTERANCE_MS) {
      logger.info(`[voice] ✗ ignored (${name}): too long (> ${MAX_UTTERANCE_MS}ms)`);
      return;
    }
    if (ms < MIN_UTTERANCE_MS) {
      logger.info(`[voice] ✗ ignored (${name}): too short (< ${MIN_UTTERANCE_MS}ms)`);
      return;
    }

    let text: string;
    try {
      text = await transcribe(await pcmToWav(pcm));
    } catch (e) {
      logger.warn(`[voice] STT failed (${name}): ${e instanceof Error ? e.message : e}`);
      return;
    }
    logger.info(`[voice] 📝 STT (${name}): ${JSON.stringify(text)}`);
    if (!text) {
      logger.info(`[voice] ✗ ignored (${name}): empty transcript`);
      return;
    }

    // Wake-word gate: only respond to (and remember) utterances that name the bot.
    const { addressed, cleaned } = addressesBot(text);
    if (!addressed) {
      logger.info(`[voice] ✗ not addressed (${name}): no wake word ("Jarvis")`);
      return;
    }
    if (!cleaned) {
      logger.info(`[voice] ✗ (${name}): addressed but no request after the name`);
      return;
    }
    logger.info(`[voice] ➡ request (${name}): ${JSON.stringify(cleaned)}`);

    // Instant ack — plays right away while the real answer is generated.
    const acks = await getAckClips().catch(() => [] as Buffer[]);
    const ack = this.pick(acks, this.lastAck);
    if (ack) {
      this.lastAck = ack;
      this.enqueueSpeech(ack);
    }

    const quick = QUICK_TRIGGER.test(cleaned);
    logger.info(`[voice] 🧠 ${quick ? "OFF (quick requested)" : "reasoning: low"} for ${name}`);

    const stopFillers = this.startFillers();
    // Only advertise web_search when the tool is actually registered — a prompt that
    // promises a missing tool sends the model into a retry loop of unknown-tool calls.
    const canSearch = isFeatureEnabled("webSearch");
    let answer: string;
    try {
      answer = await runAgent({
        system: buildVoiceSystemPrompt(
          canSearch
            ? "You can call web_search for current facts. For sports/news/current events include the current year in the query, and if the first results don't clearly answer, search again with a better query before replying. Never guess dates or facts — rely on the search results. Keep spoken answers brief."
            : "You have NO web access right now — the web-search feature is turned off. Answer from your own knowledge, never guess current facts; if asked to look something up, say web search is currently disabled. Keep spoken answers brief.",
        ),
        user: cleaned,
        history: getHistory(this.guildId),
        tools: canSearch ? [webSearchTool] : [],
        enableThinking: !quick,
        reasoningEffort: quick ? undefined : "low",
        log: (m) => logger.info(`[voice] ${m}`),
      });
    } catch (e) {
      logger.warn(`[voice] LLM failed (${name}): ${e instanceof Error ? e.message : e}`);
      return;
    } finally {
      stopFillers();
    }
    logger.info(`[voice] 💬 answer (${name}): ${JSON.stringify(answer)}`);
    recordTurn(this.guildId, cleaned, answer); // in-memory conversation context (shared per session)

    // Debug echo to the text channel where /listen was invoked.
    this.textChannel?.send(`🎤 **${name}:** ${cleaned}\n🤖 ${answer}`).catch(() => {});

    try {
      const speech = await synthesize(answer);
      this.enqueueSpeech(speech); // queued after the ack, no overlap
      logger.info(`[voice] 🔊 queued reply to ${name} (${speech.length} bytes wav)`);
    } catch (e) {
      logger.warn(`[voice] TTS failed (${name}): ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Queue a WAV buffer for playback (FIFO, no overlap). */
  private enqueueSpeech(wav: Buffer): void {
    this.speechQueue.push(createAudioResource(Readable.from(wav), { inputType: StreamType.Arbitrary }));
    this.pump();
  }

  private pump(): void {
    if (this.speaking) return;
    const next = this.speechQueue.shift();
    if (!next) return;
    this.speaking = true;
    this.player.play(next);
  }

  /** Play a filler clip every ~9s while a long answer generates; returns a stop fn. */
  private startFillers(): () => void {
    const timer = setInterval(() => {
      void getFillerClips()
        .then((clips) => {
          const clip = this.pick(clips, this.lastFiller);
          if (clip) {
            this.lastFiller = clip;
            this.enqueueSpeech(clip);
          }
        })
        .catch(() => {});
    }, 9_000);
    return () => clearInterval(timer);
  }

  /** Pick a random clip, avoiding an immediate repeat of `last`. */
  private pick(clips: Buffer[], last?: Buffer): Buffer | undefined {
    if (clips.length === 0) return undefined;
    if (clips.length === 1) return clips[0];
    const pool = last ? clips.filter((c) => c !== last) : clips;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  destroy(): void {
    this.speechQueue = [];
    clearConversation(this.guildId);
    try {
      this.player.stop(true);
    } catch {
      /* ignore */
    }
    try {
      this.connection.destroy();
    } catch {
      /* ignore */
    }
    this.activeUsers.clear();
    logger.info(`[voice] left guild ${this.guildId}`);
  }
}
