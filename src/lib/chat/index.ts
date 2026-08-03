import { ChannelType, Collection, Message } from "discord.js";
import { buildSystemPrompt, chunkText } from "../ai/llm";
import { runAgent } from "../ai/agent";
import type { ToolSpec } from "../ai/agent";
import { webSearchTool } from "../ai/tools";
import { getHistory, recordTurn } from "../ai/conversation";
import { isFeatureEnabled } from "../features";
import { logger } from "../logger";
import { linkifyDates } from "./timestamps";

// How many past messages the search_history tool pulls from the current channel.
const HISTORY_LIMIT = 150;
// Safety cap on transcript size (chars) so we never blow the model's context window.
const TRANSCRIPT_MAX_CHARS = 12_000;
// Discord's typing indicator lasts ~10s; refresh under that to keep it alive.
const TYPING_REFRESH_MS = 8_000;

// Discord API error codes we treat as "missing permissions".
const PERMISSION_ERROR_CODES = new Set([
  50001, // Missing Access
  50013, // Missing Permissions
  160002, // Cannot reply without permission to read message history
]);

/**
 * Handle a plain (non-command) message. Responds ONLY when the bot is @mentioned —
 * in DMs and guilds alike (so plain DM notes are ignored). History is read only from
 * THIS channel, so scope never leaks across channels or guilds.
 */
export async function handleChatMessage(message: Message): Promise<void> {
  if (message.author.bot || message.system) return;

  const botId = message.client.user?.id;
  if (!botId) return;

  if (!message.mentions.users.has(botId)) return; // engage only on a direct mention

  if (!isFeatureEnabled("aiChat")) {
    // Toggled off by an admin — tell the user instead of ghosting them.
    await sendReply(message, "🔴 AI chat is currently disabled.");
    return;
  }

  const question = message.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
  if (!question) return; // bare mention / empty (or missing the Message Content intent)

  const isDM = message.channel.type === ChannelType.DM;
  const scope = isDM
    ? `DM:${message.author.username}`
    : `${message.guild?.name ?? message.guildId} #${"name" in message.channel ? message.channel.name : message.channelId}`;
  logger.info(`[chat] ${message.author.username} in ${scope} asked: ${JSON.stringify(question.slice(0, 120))}`);

  const stopTyping = startTyping(message);
  try {
    // The hint must only advertise tools that are actually registered — telling the
    // model about web_search while withholding the tool sends it into a retry loop
    // of unknown-tool calls.
    const canSearch = isFeatureEnabled("webSearch");
    const hint =
      "You have tools available:\n" +
      "- `search_history`: read THIS conversation's recent messages (for questions about what was said or shared here).\n" +
      (canSearch
        ? "- `web_search`: search the web for current or external facts the user asks you to look up.\n"
        : "") +
      "Only call a tool when it is actually needed; otherwise answer directly." +
      (canSearch
        ? " Cite URLs from web_search results."
        : "\nYou have NO web access right now — the web-search feature is currently turned off. If the user asks you to look something up online, say so instead of guessing.");

    const convoKey = `chat:${message.channelId}:${message.author.id}`;
    const tools = [searchHistorySpec(message, isDM)];
    if (canSearch) tools.push(webSearchTool);
    const answer = await runAgent({
      system: buildSystemPrompt(hint),
      user: question,
      history: getHistory(convoKey),
      tools,
      log: (m) => logger.info(`[chat] ${m}`),
    });
    recordTurn(convoKey, question, answer); // in-memory follow-up context (per channel+user)

    await sendReply(message, linkifyDates(answer));
  } catch (error) {
    logger.error("[chat] handling failed", error);
    const friendly = isPermissionError(error)
      ? "I don't have the right permissions in this channel — I need **View Channel**, **Send Messages**, and **Read Message History**."
      : "Sorry — something went wrong reaching the AI.";
    await trySend(message, friendly);
  } finally {
    stopTyping();
  }
}

/** search_history tool bound to a specific message's channel (scope-safe). */
function searchHistorySpec(message: Message, isDM: boolean): ToolSpec {
  return {
    def: {
      type: "function",
      function: {
        name: "search_history",
        description:
          "Read the recent conversation history of THIS channel/DM to answer questions about what was said or shared here. " +
          'Use ONLY when the user refers to earlier messages (e.g. "what did we say about X", "find the link I sent", "summarize our chat"). ' +
          "Do NOT use it for general-knowledge questions you can answer on your own.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Optional keywords to focus on. Omit to just read the most recent messages.",
            },
          },
        },
      },
    },
    execute: async (args) => {
      const query = typeof args.query === "string" ? args.query : "";
      try {
        const transcript = await fetchTranscript(message);
        logger.info(
          `[chat]    ↳ search_history returned ${transcript ? `${transcript.length} chars` : "nothing"} (query=${JSON.stringify(query)})`,
        );
        return transcript
          ? `Recent history of this ${isDM ? "DM" : "channel"}${query ? ` (user is looking for: ${query})` : ""}, oldest first:\n${transcript}`
          : "No conversation history is available in this channel.";
      } catch (error) {
        logger.warn(`[chat]    ↳ search_history failed: ${error instanceof Error ? error.message : error}`);
        return isPermissionError(error)
          ? "I could not read this channel's message history — I'm missing the 'Read Message History' permission here. Tell the user you can't search the history without it."
          : "Searching the history failed due to a temporary error.";
      }
    },
  };
}

/** Keep the "…is typing" indicator alive until we send a reply. Returns a stop fn. */
function startTyping(message: Message): () => void {
  const channel = message.channel;
  if (!channel.isSendable()) return () => {};
  const tick = () => {
    channel.sendTyping().catch(() => {});
  };
  tick();
  const timer = setInterval(tick, TYPING_REFRESH_MS);
  return () => clearInterval(timer);
}

/** Reply with the first chunk, then follow-ups. Falls back to plain send if reply is not allowed. */
async function sendReply(message: Message, text: string): Promise<void> {
  const chunks = chunkText(text);
  try {
    await message.reply(chunks[0]);
  } catch (error) {
    if (isPermissionError(error)) await trySend(message, chunks[0]);
    else throw error;
  }
  for (const chunk of chunks.slice(1)) await trySend(message, chunk);
}

/** Best-effort plain send that never throws. */
async function trySend(message: Message, content: string): Promise<void> {
  if (!message.channel.isSendable()) return;
  await message.channel
    .send(content)
    .catch((e) => logger.warn(`[chat] could not send message: ${e instanceof Error ? e.message : e}`));
}

function isPermissionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    PERMISSION_ERROR_CODES.has((error as { code: number }).code)
  );
}

/** Fetch up to HISTORY_LIMIT recent messages from THIS channel and format a transcript. */
async function fetchTranscript(message: Message): Promise<string> {
  const channel = message.channel;
  if (!channel.isTextBased()) return "";
  const botId = message.client.user?.id;

  const collected: Message[] = [];
  let before: string | undefined = message.id; // exclude the triggering message itself
  while (collected.length < HISTORY_LIMIT) {
    const batch: Collection<string, Message> = await channel.messages.fetch({
      limit: Math.min(100, HISTORY_LIMIT - collected.length),
      before,
    });
    if (batch.size === 0) break;
    const arr: Message[] = [...batch.values()];
    collected.push(...arr);
    before = arr[arr.length - 1].id;
    if (batch.size < 100) break;
  }

  const lines = collected
    .reverse()
    .filter((m) => m.content && m.content.trim())
    .map(
      (m) => `${m.author.id === botId ? "Sonus" : m.author.username}: ${m.content.replace(/\s*\n\s*/g, " ").trim()}`,
    );

  let transcript = lines.join("\n");
  if (transcript.length > TRANSCRIPT_MAX_CHARS) {
    transcript = transcript.slice(transcript.length - TRANSCRIPT_MAX_CHARS);
    transcript = transcript.slice(transcript.indexOf("\n") + 1);
  }
  return transcript;
}
