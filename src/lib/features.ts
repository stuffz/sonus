import { config } from "./config";
import { getFeatureFlags, setFeatureFlag } from "./storage";
import { logger } from "./logger";

/** Runtime-toggleable features, controlled by admins via /status buttons. */
export type FeatureKey = "aiChat" | "aiAsk" | "aiVoice" | "webSearch";

export interface FeatureMeta {
  key: FeatureKey;
  /** Short label for the status button. */
  label: string;
  emoji: string;
  /** Longer name for the status embed / logs. */
  name: string;
  /** Whether the underlying service is configured at all. If not, the toggle is moot. */
  configured: () => boolean;
}

const ollamaConfigured = () => Boolean(config.OLLAMA_API_URL && config.OLLAMA_MODEL);

/** The features that appear as toggle buttons on /status, in display order. */
export const FEATURES: FeatureMeta[] = [
  { key: "aiChat", label: "Chat", emoji: "💬", name: "AI Chat (@mentions)", configured: ollamaConfigured },
  { key: "aiAsk", label: "Ask", emoji: "❓", name: "AI /ask command", configured: ollamaConfigured },
  { key: "aiVoice", label: "Voice", emoji: "🎤", name: "Voice AI (wake word)", configured: ollamaConfigured },
  {
    key: "webSearch",
    label: "Web Search",
    emoji: "🔎",
    name: "Web search tool",
    configured: () => Boolean(config.SEARXNG_URL),
  },
];

const META = new Map<FeatureKey, FeatureMeta>(FEATURES.map((f) => [f.key, f]));

/** Enabled unless explicitly turned off. A feature whose service isn't configured is never enabled. */
export function isFeatureEnabled(key: FeatureKey): boolean {
  const meta = META.get(key);
  if (meta && !meta.configured()) return false;
  return getFeatureFlags()[key] ?? true;
}

/** Persist a feature's on/off state. */
export function setFeature(key: FeatureKey, value: boolean): void {
  setFeatureFlag(key, value);
  logger.info(`[features] ${key} → ${value ? "ON" : "OFF"}`);
}

/** Flip a feature and return its new state. */
export function toggleFeature(key: FeatureKey): boolean {
  const next = !isFeatureEnabled(key);
  setFeature(key, next);
  return next;
}
