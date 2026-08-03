import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { logger } from "./logger";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STORAGE_PATH = join(__dirname, "..", "..", "data", "state.json");

interface GuildSettings {
  voicelogChannel?: string;
  musicChannel?: string;
  backgroundPlaylist?: string;
  backgroundEnabled?: boolean;
}

interface UserSettings {
  timezone?: string;
}

export interface Reminder {
  id: string;
  userId: string;
  channelId: string;
  guildId: string | null;
  message: string;
  triggerAt: number;
  createdAt: number;
}

interface StorageData {
  guilds: Record<string, GuildSettings>;
  users: Record<string, UserSettings>;
  reminders: Reminder[];
  // Global runtime feature toggles (admin-controlled via /status). Absent key = default (on).
  features: Record<string, boolean>;
}

let data: StorageData = { guilds: {}, users: {}, reminders: [], features: {} };

export function loadStorage(): void {
  if (!existsSync(STORAGE_PATH)) {
    logger.debug("No state.json found, starting fresh");
    return;
  }

  try {
    const content = readFileSync(STORAGE_PATH, "utf-8");
    data = { guilds: {}, users: {}, reminders: [], features: {}, ...JSON.parse(content) };
    logger.debug(`Loaded state: ${Object.keys(data.guilds).length} guild(s), ${data.reminders.length} reminder(s)`);
  } catch (error) {
    logger.error("Failed to load state.json", error);
  }
}

function saveStorage(): void {
  try {
    writeFileSync(STORAGE_PATH, JSON.stringify(data, null, 2));
  } catch (error) {
    logger.error("Failed to save state.json", error);
  }
}

export function getGuildSettings(guildId: string): GuildSettings {
  return data.guilds[guildId] ?? {};
}

export function getAllGuildSettings(): Record<string, GuildSettings> {
  return data.guilds;
}

export function setGuildSettings(guildId: string, settings: Partial<GuildSettings>): void {
  data.guilds[guildId] = { ...data.guilds[guildId], ...settings };
  saveStorage();
}

// User settings
export function getUserTimezone(userId: string): string | undefined {
  return data.users[userId]?.timezone;
}

export function getAllUserSettings(): Record<string, UserSettings> {
  return data.users;
}

export function setUserTimezone(userId: string, timezone: string): void {
  data.users[userId] = { ...data.users[userId], timezone };
  saveStorage();
}

// Reminder functions
export function addReminder(reminder: Omit<Reminder, "id" | "createdAt">): Reminder {
  const newReminder: Reminder = {
    ...reminder,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  data.reminders.push(newReminder);
  saveStorage();
  return newReminder;
}

export function getReminders(): Reminder[] {
  return data.reminders;
}

export function getDueReminders(): Reminder[] {
  const now = Date.now();
  return data.reminders.filter((r) => r.triggerAt <= now);
}

export function removeReminder(id: string): void {
  data.reminders = data.reminders.filter((r) => r.id !== id);
  saveStorage();
}

export function getUserReminders(userId: string): Reminder[] {
  return data.reminders.filter((r) => r.userId === userId);
}

// Feature flags (global runtime toggles)
export function getFeatureFlags(): Record<string, boolean> {
  return data.features;
}

export function setFeatureFlag(key: string, value: boolean): void {
  data.features[key] = value;
  saveStorage();
}
