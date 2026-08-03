import { DisTube, Queue, Song, Playlist, Events } from "distube";
import { YtDlpPlugin } from "@distube/yt-dlp";
import { Client, GuildMember, TextChannel } from "discord.js";
import { generateDependencyReport } from "@discordjs/voice";
import { logger } from "../logger";
import { getAllGuildSettings, getGuildSettings } from "../storage";
import { updateYtDlp } from "./ytdlp";
import { createNowPlayingEmbed } from "./embeds";
import {
  cacheBackgroundPlaylist,
  getBackgroundState,
  getNextBackgroundSongUrl,
  playRandomBackground,
  setBackgroundActive,
} from "./background";

const isDebug = (process.env.LOG_LEVEL ?? "").toLowerCase() === "debug";

let distube: DisTube | null = null;

// In-memory cache for music channels (loaded from storage on init)
const musicChannels = new Map<string, string>();

export function setMusicChannel(guildId: string, channelId: string | undefined): void {
  if (channelId) {
    musicChannels.set(guildId, channelId);
  } else {
    musicChannels.delete(guildId);
  }
}

export function getMusicChannel(guildId: string): string | undefined {
  return musicChannels.get(guildId);
}

function getOutputChannel(queue: Queue): TextChannel | undefined {
  const guildId = queue.id;
  const lockedChannelId = musicChannels.get(guildId);

  if (lockedChannelId && queue.distube.client.channels.cache.has(lockedChannelId)) {
    const channel = queue.distube.client.channels.cache.get(lockedChannelId);
    if (channel instanceof TextChannel) {
      return channel;
    }
  }

  // Fall back to the queue's text channel
  return queue.textChannel as TextChannel | undefined;
}

export async function initMusic(client: Client): Promise<DisTube> {
  // Load saved music channels from storage
  const allGuilds = getAllGuildSettings();
  for (const [guildId, settings] of Object.entries(allGuilds)) {
    if (settings.musicChannel) {
      musicChannels.set(guildId, settings.musicChannel);
    }
  }

  // Download/update yt-dlp binary before creating DisTube
  try {
    await updateYtDlp();
  } catch {
    logger.warn("Failed to update yt-dlp, using existing binary");
  }

  // Simple setup - just use YtDlpPlugin for YouTube
  // Spotify URLs are resolved to YouTube URLs via idonthavespotify.sjdonado.com before calling play()
  distube = new DisTube(client, {
    plugins: [
      new YtDlpPlugin({
        update: false, // We handle update ourselves above
      }),
    ],
    // FFmpeg options to reduce stuttering
    // See: https://ffmpeg.org/ffmpeg-protocols.html#http
    ffmpeg: {
      args: {
        global: {
          loglevel: "warning",
        },
        input: {
          // HTTP reconnect options
          reconnect: 1,
          reconnect_streamed: 1,
          reconnect_delay_max: 5,
          reconnect_on_network_error: 1,
          reconnect_on_http_error: "4xx,5xx",
          // Use persistent HTTP connections
          multiple_requests: 1,
          // Small probe so demux starts before much network data has arrived;
          // larger values delay first output and starve the audio player on long files.
          probesize: 1_000_000,
          analyzeduration: 1_000_000,
          // Thread queue for smoother demuxing
          thread_queue_size: 2048,
          // Generate presentation timestamps
          fflags: "+genpts+discardcorrupt",
        },
        output: {
          // dynaudnorm is a streaming-friendly loudness normalizer (no big lookahead buffer).
          // loudnorm caused ~1.9s first-byte latency, starving the Discord AudioPlayer on long mixes.
          af: "dynaudnorm=f=500:g=15",
        },
      },
    },
  });

  // Log voice dependency report at startup when debug is enabled
  if (isDebug) {
    logger.debug("Voice dependency report:\n" + generateDependencyReport());
  }

  // Forward DisTube internal debug messages to our logger
  distube.on(Events.DEBUG, (message: string) => {
    logger.debug(`[DisTube] ${message}`);
  });

  // Hook into voice connections to log state changes and DAVE negotiation
  if (isDebug) {
    const origCreate = distube.voices.create.bind(distube.voices);
    distube.voices.create = function (...args: Parameters<typeof origCreate>) {
      const voice = origCreate(...args);
      const conn = voice.connection;
      if (conn) {
        logger.debug(`[Voice] Connection created for guild ${voice.id}, status: ${conn.state.status}`);
        conn.on("stateChange", (oldState: { status: string }, newState: { status: string }) => {
          logger.debug(`[Voice] State change: ${oldState.status} → ${newState.status}`);
        });
        conn.on("debug", (message: string) => {
          logger.debug(`[Voice:debug] ${message}`);
        });
        conn.on("error", (error: Error) => {
          logger.error(`[Voice] Connection error: ${error.message}`, error);
        });
      }
      return voice;
    };
  }

  distube.on(Events.PLAY_SONG, (queue: Queue, song: Song) => {
    const guildId = queue.id;
    const bgState = getBackgroundState(guildId);
    const channel = getOutputChannel(queue);
    const isBackground = bgState?.isActive ?? false;

    const embed = createNowPlayingEmbed(song, isBackground);
    void channel?.send({ embeds: [embed] });
  });

  distube.on(Events.ADD_SONG, (queue: Queue, song: Song) => {
    const guildId = queue.id;
    const bgState = getBackgroundState(guildId);

    // Don't show "Added to queue" for background songs
    if (bgState?.suppressAddMessage) {
      bgState.suppressAddMessage = false;
      return;
    }

    const channel = getOutputChannel(queue);
    void channel?.send(`Added to queue: **${song.name}** - \`${song.formattedDuration}\``);
  });

  distube.on(Events.ADD_LIST, (queue: Queue, playlist: Playlist) => {
    const channel = getOutputChannel(queue);
    void channel?.send(`Added playlist: **${playlist.name}** - ${playlist.songs.length} songs`);
  });

  distube.on(Events.FINISH, (queue: Queue) => {
    const guildId = queue.id;
    const settings = getGuildSettings(guildId);
    const bgState = getBackgroundState(guildId);
    const channel = getOutputChannel(queue);
    const voiceChannel = queue.voice.channel;

    // Try to start background playlist
    if (settings.backgroundEnabled && bgState && bgState.songs.length > 0 && voiceChannel) {
      // Small delay to avoid race conditions
      setTimeout(async () => {
        try {
          const started = await playRandomBackground(distube!, guildId, voiceChannel, channel);
          if (!started) {
            void channel?.send("Queue finished. (Background playlist songs failed to load)");
          }
        } catch (error) {
          logger.error("Failed to start background playlist", error);
          void channel?.send("Queue finished.");
        }
      }, 500);
    } else {
      void channel?.send("Queue finished.");
    }
  });

  distube.on(Events.DISCONNECT, (queue: Queue) => {
    const guildId = queue.id;
    setBackgroundActive(guildId, false);
    const channel = getOutputChannel(queue);
    void channel?.send("Disconnected from voice channel.");
  });

  distube.on(Events.ERROR, (error: Error, queue: Queue) => {
    const voiceState = queue.voice?.connection?.state;
    logger.error("DisTube error", {
      message: error.message,
      name: error.name,
      stack: error.stack,
      song: queue.songs[0]?.name,
      url: queue.songs[0]?.url,
      voiceStatus: voiceState?.status,
    });
    const channel = getOutputChannel(queue);
    void channel?.send(`Error: ${error.message}`);
  });

  // Debug event to trace playback issues
  distube.on(Events.FFMPEG_DEBUG, (debug: string) => {
    logger.debug("FFmpeg debug", debug);
  });

  // Pre-cache background playlists for guilds that have them configured
  // yt-dlp is ready since we awaited updateYtDlp() above
  for (const [guildId, settings] of Object.entries(allGuilds)) {
    if (settings.backgroundPlaylist && settings.backgroundEnabled) {
      // Cache in the background without blocking startup
      cacheBackgroundPlaylist(guildId, settings.backgroundPlaylist)
        .then(({ name, count }) => {
          logger.info(`Cached background playlist "${name}" (${count} songs) for guild ${guildId}`);
        })
        .catch((err) => {
          logger.warn(`Failed to cache background playlist for guild ${guildId}: ${err.message}`);
        });
    }
  }

  logger.info("Music player initialized");
  return distube;
}

export function getPlayer(): DisTube {
  if (!distube) {
    throw new Error("Music player not initialized");
  }
  return distube;
}

export type SkipOutcome = "skipped" | "background-next" | "background-started" | "empty" | "background-failed";

/**
 * Skip the current song, rolling into the background playlist when the queue would
 * otherwise run dry (mirroring the FINISH handler). Shared by /skip and the web API.
 * Continues in the queue's own voice channel, so it works without an invoking member.
 */
export async function skipCurrentSong(
  queue: Queue,
  opts?: { member?: GuildMember; textChannel?: TextChannel },
): Promise<SkipOutcome> {
  const guildId = queue.id;

  // Resume if paused so skip can proceed cleanly
  if (queue.paused) {
    try {
      await queue.resume();
    } catch {
      /* ignore, skip/stop below will handle it */
    }
  }

  if (queue.songs.length > 1) {
    await queue.skip();
    return "skipped";
  }

  // Skipping the last song: try to roll into the background playlist.
  const settings = getGuildSettings(guildId);
  const bgState = getBackgroundState(guildId);
  const voiceChannel = queue.voice.channel;
  const wasInBackground = bgState?.isActive ?? false;

  if (voiceChannel && settings.backgroundEnabled && bgState && bgState.songs.length > 0) {
    const nextUrl = await getNextBackgroundSongUrl(guildId);
    if (nextUrl) {
      bgState.isActive = true;
      try {
        // Queue the next background song, then skip the current one onto it.
        await queue.distube.play(voiceChannel, nextUrl, {
          member: opts?.member,
          textChannel: opts?.textChannel ?? getOutputChannel(queue),
        });
        await queue.skip();
        return wasInBackground ? "background-next" : "background-started";
      } catch {
        bgState.isActive = false;
        return "background-failed";
      }
    }
  }

  await queue.stop();
  return "empty";
}

/**
 * Attempt to recover from a broken music state.
 * Cleans up queues that have no songs (zombie queues left by failed play attempts)
 * and disconnects broken voice connections.
 */
export function attemptMusicRecovery(): void {
  if (!distube) return;

  const client = distube.client;
  client.guilds.cache.forEach((guild) => {
    try {
      const queue = distube!.getQueue(guild.id);
      if (queue && queue.songs.length === 0) {
        logger.warn(`[Recovery] Cleaning up broken queue for guild ${guild.name}`);
        try {
          void queue.stop();
        } catch {
          /* ignore */
        }
        try {
          distube!.voices.leave(guild.id);
        } catch {
          /* ignore */
        }
      }
    } catch {
      // Queue accessor itself threw — force leave voice
      try {
        distube!.voices.leave(guild.id);
      } catch {
        /* ignore */
      }
    }
  });
}

/**
 * Clean up a broken queue for a specific guild.
 * Only destroys the queue if it has no songs left (zombie state).
 * Returns true if cleanup was performed.
 */
export function cleanupBrokenQueue(guildId: string): boolean {
  if (!distube) return false;
  try {
    const queue = distube.getQueue(guildId);
    // Only clean up if the queue exists but is empty (zombie)
    if (queue && queue.songs.length === 0) {
      logger.warn(`[Recovery] Cleaning up empty queue for guild ${guildId}`);
      try {
        void queue.stop();
      } catch {
        /* ignore */
      }
      try {
        distube.voices.leave(guildId);
      } catch {
        /* ignore */
      }
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

// Check if bot is alone in voice channels and leave if so
export function checkLonelyVoiceChannels(): void {
  if (!distube) {
    logger.debug("[LonelyCheck] DisTube not initialized");
    return;
  }

  // Check all guilds for bot's voice state (DisTube manages connections internally)
  const client = distube.client;
  let checkedCount = 0;

  client.guilds.cache.forEach((guild) => {
    const botMember = guild.members.me;
    const voiceChannel = botMember?.voice.channel;

    // Skip if bot is not in a voice channel in this guild
    if (!voiceChannel) return;

    checkedCount++;

    // Get members in the voice channel (excluding bots)
    const allMembers = voiceChannel.members;
    const humanMembers = allMembers.filter((member: GuildMember) => !member.user.bot);

    logger.debug(
      `[LonelyCheck] ${guild.name}#${voiceChannel.name}: ${allMembers.size} total, ${humanMembers.size} humans`,
    );

    if (humanMembers.size === 0) {
      logger.info(`Leaving empty voice channel in ${guild.name}`);

      // Reset background state
      setBackgroundActive(guild.id, false);

      // Stop queue and disconnect - the DISCONNECT event will send the message
      const queue = distube!.queues.get(guild.id);
      if (queue) {
        void queue.stop();
      }
      // Always explicitly leave the voice channel
      distube!.voices.leave(guild.id);
    }
  });

  logger.debug(`[LonelyCheck] Checked ${checkedCount} voice connection(s)`);
}
