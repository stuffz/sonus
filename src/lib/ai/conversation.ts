import type { ChatMessage } from "./llm";

// In-memory only — deliberately NOT persisted to the state file. Lost on restart.
type Conversation = { turns: ChatMessage[]; lastActive: number };
const store = new Map<string, Conversation>();

const MAX_TURNS = 6; // user+assistant pairs kept per conversation
const TTL_MS = 10 * 60 * 1000; // forget a conversation after 10 min idle

/** Recent turns for a conversation key (empty if none or expired). */
export function getHistory(key: string): ChatMessage[] {
  const convo = store.get(key);
  if (!convo) return [];
  if (Date.now() - convo.lastActive > TTL_MS) {
    store.delete(key);
    return [];
  }
  return convo.turns;
}

/** Append a completed turn (user question + assistant answer). Tool calls/reasoning are not stored. */
export function recordTurn(key: string, userText: string, assistantText: string): void {
  const convo = store.get(key) ?? { turns: [], lastActive: 0 };
  convo.turns.push({ role: "user", content: userText }, { role: "assistant", content: assistantText });
  if (convo.turns.length > MAX_TURNS * 2) {
    convo.turns = convo.turns.slice(-MAX_TURNS * 2);
  }
  convo.lastActive = Date.now();
  store.set(key, convo);
}

/** Drop a conversation (e.g. on /leave). */
export function clearConversation(key: string): void {
  store.delete(key);
}
