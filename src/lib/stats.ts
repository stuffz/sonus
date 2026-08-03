import type { Client, Guild } from "discord.js";
import type { Queue } from "distube";
import { config } from "./config";
import { cron } from "./cron";
import { getPlayer, getYtDlpVersion, getLatestYtDlpVersion, getBackgroundState } from "./music/index";
import { isListening } from "./voice/index";
import { getQuoteCommandsCount } from "./quotes";
import { getAllGuildSettings, getGuildSettings, getAllUserSettings, getReminders } from "./storage";
import { FEATURES, isFeatureEnabled } from "./features";

// Shared data collectors behind both the /status command and the web API
// (src/lib/web/server.ts). Keep these presentation-free: raw numbers and
// strings only, formatting happens at the edges.

export interface RuntimeStats {
  uptimeSeconds: number;
  heapUsedBytes: number;
  rssBytes: number;
  guilds: number;
  users: number;
  pingMs: number;
  nodeVersion: string;
}

export function getRuntimeStats(client: Client): RuntimeStats {
  const mem = process.memoryUsage();
  return {
    uptimeSeconds: process.uptime(),
    heapUsedBytes: mem.heapUsed,
    rssBytes: mem.rss,
    guilds: client.guilds.cache.size,
    users: client.users.cache.size,
    pingMs: client.ws.ping,
    nodeVersion: process.version,
  };
}

export interface MusicStats {
  playerReady: boolean;
  activeVoice: number;
  queuedSongs: number;
  backgroundEnabled: number;
  backgroundConfigured: number;
  ytdlp: { current: string; latest: string; upToDate: boolean };
}

// yt-dlp version lookups spawn a process / hit GitHub — far too heavy for the
// dashboard's live stream, so cache them briefly.
const YTDLP_CACHE_TTL = 10 * 60 * 1000;
let ytdlpCache: { current: string; latest: string; fetchedAt: number } | null = null;

async function getYtDlpVersions(): Promise<{ current: string; latest: string }> {
  if (ytdlpCache && Date.now() - ytdlpCache.fetchedAt < YTDLP_CACHE_TTL) {
    return ytdlpCache;
  }
  const [current, latest] = await Promise.all([getYtDlpVersion(), getLatestYtDlpVersion()]);
  ytdlpCache = { current, latest, fetchedAt: Date.now() };
  return ytdlpCache;
}

export async function getMusicStats(client: Client): Promise<MusicStats> {
  let playerReady = false;
  let activeVoice = 0;
  let queuedSongs = 0;

  try {
    const distube = getPlayer();
    playerReady = true;
    client.guilds.cache.forEach((guild) => {
      const queue = distube.queues.get(guild.id);
      if (queue) {
        activeVoice++;
        queuedSongs += queue.songs.length;
      }
    });
  } catch {
    // Music player not initialized yet
  }

  const guildSettings = getAllGuildSettings();
  const backgroundEnabled = Object.values(guildSettings).filter((s) => s.backgroundEnabled).length;
  const backgroundConfigured = Object.values(guildSettings).filter((s) => s.backgroundPlaylist).length;

  const { current, latest } = await getYtDlpVersions();

  return {
    playerReady,
    activeVoice,
    queuedSongs,
    backgroundEnabled,
    backgroundConfigured,
    ytdlp: { current, latest, upToDate: current === latest },
  };
}

export interface FeatureStat {
  key: string;
  label: string;
  name: string;
  emoji: string;
  configured: boolean;
  enabled: boolean;
}

export interface FeatureStats {
  features: FeatureStat[];
  ollamaModel: string | null;
  quoteCommands: number;
}

export function getFeatureStats(): FeatureStats {
  return {
    features: FEATURES.map((f) => ({
      key: f.key,
      label: f.label,
      name: f.name,
      emoji: f.emoji,
      configured: f.configured(),
      enabled: isFeatureEnabled(f.key),
    })),
    ollamaModel: config.OLLAMA_MODEL || null,
    quoteCommands: getQuoteCommandsCount(),
  };
}

export interface StorageStats {
  guildsConfigured: number;
  voicelogEnabled: number;
  musicChannelSet: number;
  usersWithTimezone: number;
  pendingReminders: number;
}

export function getStorageStats(): StorageStats {
  const guildSettings = getAllGuildSettings();
  const userSettings = getAllUserSettings();
  return {
    guildsConfigured: Object.keys(guildSettings).length,
    voicelogEnabled: Object.values(guildSettings).filter((s) => s.voicelogChannel).length,
    musicChannelSet: Object.values(guildSettings).filter((s) => s.musicChannel).length,
    usersWithTimezone: Object.values(userSettings).filter((s) => s.timezone).length,
    pendingReminders: getReminders().length,
  };
}

export interface CronJobStat {
  name: string;
  interval: number;
  nextRun: number;
  lastRun: number | null;
}

export function getCronStats(): CronJobStat[] {
  return cron.getStatus();
}

// --- Per-guild ---

interface GuildSettingsInfo {
  voicelogChannel: ChannelRef | null;
  musicChannel: ChannelRef | null;
  backgroundPlaylist: string | null;
  backgroundEnabled: boolean;
}

interface ChannelRef {
  id: string;
  name: string | null;
}

interface BackgroundInfo {
  playlistName: string;
  cachedSongs: number;
  active: boolean;
}

export interface QueueSongInfo {
  name: string;
  url: string | null;
  durationSeconds: number;
  requestedBy: string | null;
  thumbnail: string | null;
}

export interface QueueInfo {
  paused: boolean;
  currentTimeSeconds: number;
  voiceChannel: string | null;
  songs: QueueSongInfo[];
}

export interface GuildSummary {
  id: string;
  name: string;
  iconUrl: string | null;
  memberCount: number;
  playing: boolean;
  paused: boolean;
  queueLength: number;
  nowPlaying: string | null;
  listening: boolean;
  settings: GuildSettingsInfo;
  background: BackgroundInfo | null;
}

export interface GuildDetail extends GuildSummary {
  queue: QueueInfo | null;
}

function channelRef(guild: Guild, channelId: string | undefined): ChannelRef | null {
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId);
  return { id: channelId, name: channel?.name ?? null };
}

function getQueue(guildId: string): Queue | undefined {
  try {
    return getPlayer().queues.get(guildId);
  } catch {
    return undefined;
  }
}

export function getGuildSummary(guild: Guild): GuildSummary {
  const settings = getGuildSettings(guild.id);
  const queue = getQueue(guild.id);
  const bgState = getBackgroundState(guild.id);

  return {
    id: guild.id,
    name: guild.name,
    iconUrl: guild.iconURL({ size: 128 }),
    memberCount: guild.memberCount,
    playing: Boolean(queue && queue.songs.length > 0),
    paused: queue?.paused ?? false,
    queueLength: queue?.songs.length ?? 0,
    nowPlaying: queue?.songs[0]?.name ?? null,
    listening: isListening(guild.id),
    settings: {
      voicelogChannel: channelRef(guild, settings.voicelogChannel),
      musicChannel: channelRef(guild, settings.musicChannel),
      backgroundPlaylist: settings.backgroundPlaylist ?? null,
      backgroundEnabled: settings.backgroundEnabled ?? false,
    },
    background: bgState
      ? { playlistName: bgState.playlistName, cachedSongs: bgState.songs.length, active: bgState.isActive }
      : null,
  };
}

export function getGuildSummaries(client: Client): GuildSummary[] {
  return client.guilds.cache.map((guild) => getGuildSummary(guild));
}

export function getGuildDetail(guild: Guild): GuildDetail {
  const summary = getGuildSummary(guild);
  const queue = getQueue(guild.id);

  return {
    ...summary,
    queue: queue
      ? {
          paused: queue.paused,
          currentTimeSeconds: queue.currentTime,
          voiceChannel: queue.voice.channel?.name ?? null,
          songs: queue.songs.map((song) => ({
            name: song.name ?? "Unknown",
            url: song.url ?? null,
            durationSeconds: song.duration,
            requestedBy: song.user?.username ?? null,
            thumbnail: song.thumbnail ?? null,
          })),
        }
      : null,
  };
}
