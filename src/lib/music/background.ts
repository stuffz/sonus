import type { DisTube } from "distube";
import type { TextChannel, VoiceBasedChannel } from "discord.js";
import { logger } from "../logger";
import { getGuildSettings, setGuildSettings, getAllGuildSettings } from "../storage";
import { fetchPlaylistEntries, searchYouTubeMusicUrl } from "./ytdlp";
import { isSpotifyPlaylistUrl, fetchSpotifyPlaylist } from "./spotify";
import { formatTrack, type TrackInfo } from "./match";

/** A YouTube playlist entry plays its URL; a Spotify one is searched for on YouTube when it comes up. */
type BackgroundSong = { name: string; url: string } | { name: string; track: TrackInfo };

// Background playlist state (per guild)
export interface BackgroundState {
  songs: BackgroundSong[]; // Cached songs from playlist
  playlistName: string; // Name of the playlist
  isActive: boolean; // Currently playing a background song
  playedIndices: Set<number>; // Indices of songs played in current cycle
  suppressAddMessage: boolean; // Temporarily suppress "Added to queue" for background adds
}

const backgroundStates = new Map<string, BackgroundState>();

export function isBackgroundMode(guildId: string): boolean {
  return backgroundStates.get(guildId)?.isActive ?? false;
}

export function setBackgroundActive(guildId: string, active: boolean): void {
  const state = backgroundStates.get(guildId);
  if (state) {
    state.isActive = active;
  }
}

export function getBackgroundState(guildId: string): BackgroundState | undefined {
  return backgroundStates.get(guildId);
}

export async function cacheBackgroundPlaylist(guildId: string, url: string): Promise<{ name: string; count: number }> {
  let songs: BackgroundSong[];
  let title: string;

  if (isSpotifyPlaylistUrl(url)) {
    const { tracks, title: playlistTitle } = await fetchSpotifyPlaylist(url);
    title = playlistTitle;
    songs = tracks.map((track) => ({ name: formatTrack(track), track }));
  } else {
    // YouTube/other: use yt-dlp to fetch playlist entries directly
    const result = await fetchPlaylistEntries(url);
    title = result.title;
    songs = result.urls.map((videoUrl) => ({ name: videoUrl, url: videoUrl }));
  }

  // Cache the songs
  backgroundStates.set(guildId, {
    songs,
    playlistName: title,
    isActive: false,
    playedIndices: new Set(),
    suppressAddMessage: false,
  });

  // Save URL to storage
  setGuildSettings(guildId, { backgroundPlaylist: url, backgroundEnabled: true });

  logger.info(`Cached ${songs.length} songs for background playlist in guild ${guildId}`);
  return { name: title, count: songs.length };
}

export async function updateBackgroundCache(guildId: string): Promise<{ name: string; count: number }> {
  const settings = getGuildSettings(guildId);
  if (!settings.backgroundPlaylist) {
    throw new Error("No background playlist configured");
  }
  return cacheBackgroundPlaylist(guildId, settings.backgroundPlaylist);
}

/**
 * Refresh background playlist caches for all guilds that have one configured.
 * Intended to be called periodically so new songs added to playlists are picked up.
 */
export async function refreshAllBackgroundPlaylists(): Promise<void> {
  const allGuilds = getAllGuildSettings();
  const entries = Object.entries(allGuilds).filter(([, s]) => s.backgroundPlaylist && s.backgroundEnabled);

  if (entries.length === 0) return;

  logger.info(`Refreshing background playlists for ${entries.length} guild(s)`);

  for (const [guildId, settings] of entries) {
    try {
      const { name, count } = await cacheBackgroundPlaylist(guildId, settings.backgroundPlaylist!);
      logger.info(`Refreshed background playlist "${name}" (${count} songs) for guild ${guildId}`);
    } catch (err) {
      logger.warn(
        `Failed to refresh background playlist for guild ${guildId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

export function clearBackgroundPlaylist(guildId: string): void {
  backgroundStates.delete(guildId);
  setGuildSettings(guildId, { backgroundPlaylist: undefined, backgroundEnabled: false });
}

/**
 * Resolve a background song entry to a playable URL.
 * For YouTube entries, the URL is already set.
 * For Spotify entries, we search YouTube Music for the track.
 */
async function resolvePlayUrl(song: BackgroundSong): Promise<string | null> {
  if ("url" in song) {
    return song.url;
  }

  const resolved = await searchYouTubeMusicUrl(song.track);
  if (!resolved) {
    logger.warn(`[Background] YouTube search failed for Spotify track: "${song.name}"`);
    return null;
  }
  return resolved;
}

/**
 * Get the next background song URL using smart shuffle logic.
 * This updates the played history but doesn't actually play the song.
 * For Spotify playlists, resolves the search query to a YouTube URL.
 */
export async function getNextBackgroundSongUrl(guildId: string): Promise<string | null> {
  const settings = getGuildSettings(guildId);
  if (!settings.backgroundEnabled) return null;

  const state = backgroundStates.get(guildId);
  if (!state || state.songs.length === 0) return null;

  // For single song, just return it
  if (state.songs.length === 1) {
    return resolvePlayUrl(state.songs[0]);
  }

  // Smart shuffle logic
  let resetThreshold: number;
  if (state.songs.length <= 3) {
    resetThreshold = state.songs.length - 1;
  } else {
    resetThreshold = Math.max(2, Math.floor(state.songs.length * 0.2));
  }

  if (state.playedIndices.size >= state.songs.length - resetThreshold + 1) {
    state.playedIndices.clear();
    logger.debug(`Background playlist cycle complete for guild ${guildId}, resetting history`);
  }

  // Get available (unplayed) song indices
  const availableIndices: number[] = [];
  for (let i = 0; i < state.songs.length; i++) {
    if (!state.playedIndices.has(i)) {
      availableIndices.push(i);
    }
  }

  // Pick a random song from available ones
  const randomIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
  const song = state.songs[randomIndex];
  state.playedIndices.add(randomIndex);

  return resolvePlayUrl(song);
}

export async function playRandomBackground(
  distube: DisTube,
  guildId: string,
  voiceChannel: VoiceBasedChannel,
  textChannel?: TextChannel,
): Promise<boolean> {
  const settings = getGuildSettings(guildId);
  if (!settings.backgroundEnabled) return false;

  const state = backgroundStates.get(guildId);
  if (!state || state.songs.length === 0) return false;

  // Retry up to 5 times (or total songs, whichever is smaller) to handle
  // videos that are unavailable, region-blocked, or cause transient yt-dlp errors
  const maxRetries = Math.min(5, state.songs.length);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Smart shuffle: avoid recently played songs
    // For single song: just repeat it
    // For small playlists (2-3 songs): just avoid the last played song
    // For larger playlists: reset when 80% played (keeping at least 2 unplayed)

    let song: BackgroundSong;

    if (state.songs.length === 1) {
      song = state.songs[0];
      // No point retrying the same single song multiple times
      if (attempt > 0) break;
    } else {
      let resetThreshold: number;
      if (state.songs.length <= 3) {
        // For tiny playlists, just avoid repeating the immediately previous song
        resetThreshold = state.songs.length - 1;
      } else {
        resetThreshold = Math.max(2, Math.floor(state.songs.length * 0.2));
      }

      if (state.playedIndices.size >= state.songs.length - resetThreshold + 1) {
        state.playedIndices.clear();
        logger.debug(`Background playlist cycle complete for guild ${guildId}, resetting history`);
      }

      // Get available (unplayed) song indices
      const availableIndices: number[] = [];
      for (let i = 0; i < state.songs.length; i++) {
        if (!state.playedIndices.has(i)) {
          availableIndices.push(i);
        }
      }

      // Pick a random song from available ones
      const randomIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
      song = state.songs[randomIndex];
      state.playedIndices.add(randomIndex);
    }

    try {
      state.isActive = true;
      state.suppressAddMessage = true;
      const playUrl = await resolvePlayUrl(song);
      if (!playUrl) {
        logger.warn(`[Background] Skipping unresolvable track (attempt ${attempt + 1}/${maxRetries}): ${song.name}`);
        state.isActive = false;
        continue;
      }
      await distube.play(voiceChannel, playUrl, {
        textChannel,
      });
      return true;
    } catch (error) {
      logger.warn(`[Background] Failed to play track (attempt ${attempt + 1}/${maxRetries}): ${song.name}`, error);
      state.isActive = false;
      state.suppressAddMessage = false;
      // Continue to try another song
    }
  }

  logger.error(`[Background] All ${maxRetries} attempts failed for guild ${guildId}`);
  return false;
}
