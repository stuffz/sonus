import { config } from "../config";

// Discord hard-caps message content at 2000 characters.
export const DISCORD_MAX_LENGTH = 2000;

// Headroom reserved so the code-fence lines we may re-add can't push a chunk
// over Discord's hard limit (open ```lang\n + closing \n``` ≈ 20 chars worst case).
const FENCE_RESERVE = 24;

export type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
export type AssistantMessage = {
  role: "assistant";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
};

// The markdown rules Discord actually renders — shared by every prompt variant.
const DISCORD_MARKDOWN_RULES = [
  "Format every reply using Discord-flavored markdown, and follow these rules exactly:",
  "- Headers: use only '# ', '## ', or '### '. Discord supports at most three header levels — NEVER use '####' or deeper (they render as literal '#' characters).",
  "- Emphasis/code: use **bold**, *italic*, `inline code`, and fenced ```lang code blocks```.",
  "- Lists: use '- ' bullets or '1.' numbers; use '> ' for quotes.",
  "- Do NOT use markdown tables or horizontal rules ('---') — Discord does not render them. Use lists instead.",
  "- Do NOT use masked links like [text](url) — they show as literal text in normal messages. Paste raw URLs.",
  "Keep answers concise and well-structured for a chat window.",
].join("\n");

/** Current date/time in the bot's home timezone, for grounding the model. */
function currentDateTime(): string {
  // DST-aware: Europe/Stockholm renders as CET in winter, CEST in summer.
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Stockholm",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date());
}

/**
 * The standard grounding system prompt for text chat: identity + live date/time +
 * Discord markdown rules. Built fresh per request so the date/time is current.
 * `extra` appends situation-specific context (e.g. "you have the recent history").
 * A separate voice-chat variant can be added later.
 */
export function buildSystemPrompt(extra?: string): string {
  return [
    "You are Sonus, a friendly and concise AI assistant living in a Discord server.",
    "You chat with users, answer questions, and help out. Music playback, reminders, and similar actions are handled by dedicated slash commands/tools — you cannot perform them from a plain chat message yet, so point users to the relevant command if they ask.",
    `The current date and time is ${currentDateTime()} (Europe/Stockholm).`,
    "If you don't know something or lack the information, say so plainly instead of guessing.",
    extra ? `\n${extra}` : "",
    "",
    DISCORD_MARKDOWN_RULES,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Voice-chat variant of the system prompt: replies are read aloud by TTS, so no markdown,
 * no URLs, and short spoken sentences. Built fresh per request for the live date/time.
 */
export function buildVoiceSystemPrompt(extra?: string): string {
  return [
    "You are Sonus, a friendly assistant speaking in a Discord voice channel.",
    `The current date and time is ${currentDateTime()} (Europe/Stockholm).`,
    "The user is in the Europe/Stockholm timezone (currently CEST, UTC+2). ALWAYS state dates and times in Europe/Stockholm time.",
    "If a source or search result gives a time in another timezone (e.g. US Eastern / ET / EDT is UTC-4, so 5 PM Eastern = 11 PM Stockholm; Pacific / PT is UTC-7), CONVERT it to Europe/Stockholm first and do NOT mention the original timezone.",
    "Your replies are READ ALOUD by text-to-speech, so follow these rules strictly:",
    "- Reply in plain, natural spoken sentences. NO markdown, NO bullet points, NO code blocks, NO emojis, NO URLs, NO asterisks or backticks.",
    "- Be brief: usually 1–3 sentences. Say numbers and times the way a person speaks them (e.g. 'eleven tonight', 'half past three').",
    "- If you don't know, say so briefly.",
    extra ? `\n${extra}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Displayable text from an assistant message (thinking models may use reasoning_content). */
export function extractText(message: { content?: string | null; reasoning_content?: string } | undefined): string {
  return (
    (message?.content && message.content.trim()) ||
    (message?.reasoning_content && `_(reasoning only)_\n${message.reasoning_content}`) ||
    "(No response from the model.)"
  );
}

/** Low-level call — returns the raw assistant message, which may contain tool_calls. */
export async function chatCompletionRaw(
  messages: ChatMessage[],
  opts: { tools?: ToolDef[]; enableThinking?: boolean; reasoningEffort?: "low" | "medium" | "high" } = {},
): Promise<AssistantMessage> {
  if (!config.OLLAMA_API_URL || !config.OLLAMA_MODEL) {
    throw new Error("OLLAMA_API_URL or OLLAMA_MODEL is not configured.");
  }
  const body: Record<string, unknown> = { model: config.OLLAMA_MODEL, messages };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  // Explicitly toggle Gemma's thinking mode / reasoning effort when requested.
  if (opts.enableThinking !== undefined) {
    const kwargs: Record<string, unknown> = { enable_thinking: opts.enableThinking };
    if (opts.enableThinking && opts.reasoningEffort) kwargs.reasoning_effort = opts.reasoningEffort;
    body.chat_template_kwargs = kwargs;
  }
  const res = await fetch(`${config.OLLAMA_API_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`LLM error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message ?? { role: "assistant", content: null };
}

/** Convenience: single-shot text answer with no tools. */
export async function chatCompletion(messages: ChatMessage[]): Promise<string> {
  return extractText(await chatCompletionRaw(messages));
}

/**
 * Split text into Discord-sized pieces, breaking as gracefully as possible:
 *   1. on blank lines (keep whole paragraphs together),
 *   2. then on line breaks if a single paragraph is too big,
 *   3. then a hard character cut only if a single line is still too big.
 * Any fenced code block that gets split across a boundary is closed and reopened
 * so each piece still renders as code in Discord.
 */
export function chunkText(text: string, max = DISCORD_MAX_LENGTH): string[] {
  const limit = max - FENCE_RESERVE;
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      chunks.push(buf);
      buf = "";
    }
  };

  // Pack a single line, hard-splitting it only as a last resort.
  const addLine = (line: string) => {
    const candidate = buf ? `${buf}\n${line}` : line;
    if (candidate.length <= limit) {
      buf = candidate;
      return;
    }
    flush();
    if (line.length <= limit) {
      buf = line;
      return;
    }
    for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
  };

  // Prefer paragraph boundaries (a blank line between blocks).
  for (const para of text.split(/\n\s*\n/)) {
    const candidate = buf ? `${buf}\n\n${para}` : para;
    if (candidate.length <= limit) {
      buf = candidate;
      continue;
    }
    flush();
    if (para.length <= limit) {
      buf = para;
      continue;
    }
    for (const line of para.split("\n")) addLine(line); // paragraph too big — pack by line
  }
  flush();

  return balanceCodeFences(chunks.length ? chunks : [text]);
}

/** Close an unterminated ``` block at a chunk's end and reopen it in the next chunk. */
function balanceCodeFences(chunks: string[]): string[] {
  const out: string[] = [];
  let openLang: string | null = null; // language of a fence carried over from the previous chunk
  for (let piece of chunks) {
    if (openLang !== null) piece = `\`\`\`${openLang}\n${piece}`;
    const fenceCount = (piece.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
      // This piece leaves a code block open — remember its language and close it here.
      const opens = [...piece.matchAll(/```([^\n`]*)/g)];
      openLang = opens.length ? opens[opens.length - 1][1] : "";
      piece = `${piece}\n\`\`\``;
    } else {
      openLang = null;
    }
    out.push(piece);
  }
  return out;
}
