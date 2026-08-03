import { ActivityType, Client, GuildMember, MessageFlags, Partials, TextChannel } from "discord.js";
import { config } from "./lib/config";
import { commands } from "./commands/commands";
import { cron } from "./lib/cron";
import { logger } from "./lib/logger";
import { loadStorage, getGuildSettings, getDueReminders, removeReminder } from "./lib/storage";
import {
  initMusic,
  checkLonelyVoiceChannels,
  checkYtDlpUpdate,
  refreshAllBackgroundPlaylists,
  attemptMusicRecovery,
} from "./lib/music/index";
import { handleChatMessage } from "./lib/chat/index";
import { startWebServer } from "./lib/web/server";

// Prevent crashes from unhandled promise rejections
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", reason instanceof Error ? reason : { reason });
  attemptMusicRecovery();
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", error);
  attemptMusicRecovery();
});

loadStorage();

export const client = new Client({
  // MessageContent is a privileged intent — it must also be enabled in the
  // Discord Developer Portal (Bot → Privileged Gateway Intents). Without it,
  // message.content is empty for non-mention/non-DM messages.
  intents: ["Guilds", "GuildMessages", "DirectMessages", "GuildVoiceStates", "MessageContent"],
  // Channel partial is required to receive DM messages for uncached DM channels.
  partials: [Partials.Channel],
});

client.once("clientReady", async () => {
  logger.success(`Logged in as ${client.user?.username}`);
  const guildList = client.guilds.cache.map((g) => g.name).join(", ");
  logger.info(`Serving ${client.guilds.cache.size} guild(s): ${guildList}`);

  // Initialize music player (waits for yt-dlp to be ready)
  await initMusic(client);

  // Set bot presence
  const activityTypes: Record<string, ActivityType> = {
    Playing: ActivityType.Playing,
    Streaming: ActivityType.Streaming,
    Listening: ActivityType.Listening,
    Watching: ActivityType.Watching,
    Competing: ActivityType.Competing,
  };
  client.user?.setPresence({
    activities: [
      {
        name: config.PRESENCE_TEXT,
        type: activityTypes[config.PRESENCE_TYPE] ?? ActivityType.Playing,
      },
    ],
    status: "online",
  });

  // Start reminder scheduler
  cron.register("reminders", 10_000, checkReminders, true);

  // Check for empty voice channels every minute
  cron.register("lonelyVoice", 60_000, checkLonelyVoiceChannels);

  // Refresh background playlists every 6 hours to pick up new songs
  cron.register("backgroundRefresh", 6 * 60 * 60 * 1000, refreshAllBackgroundPlaylists);

  // Check for yt-dlp updates daily (24 hours)
  cron.register("ytdlpUpdate", 24 * 60 * 60 * 1000, async () => {
    await checkYtDlpUpdate();
  });
});

client.on("interactionCreate", async (interaction) => {
  // Handle autocomplete
  if (interaction.isAutocomplete()) {
    const command = commands[interaction.commandName];
    if (command?.autocomplete) {
      try {
        await command.autocomplete(interaction);
      } catch (error) {
        logger.error(`Autocomplete failed for /${interaction.commandName}`, error);
      }
    }
    return;
  }

  // Buttons on the /status message (admin control panel).
  if (interaction.isButton()) {
    if (interaction.customId.startsWith("status:")) {
      try {
        const { handleButton } = await import("./commands/status");
        await handleButton(interaction);
      } catch (error) {
        logger.error("status button handler failed", error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const { commandName } = interaction;
  const username = interaction.user.username;
  const member = interaction.member;
  const displayName = member instanceof GuildMember ? member.displayName : interaction.user.displayName;
  const guild = interaction.guild?.name ?? "DM";

  logger.info(`[${guild}] ${displayName} (${username}) used /${commandName}`);

  const command = commands[commandName];
  if (command) {
    try {
      await command.execute(interaction);
      logger.debug(`[${guild}] /${commandName} completed`);
    } catch (error) {
      logger.error(`[${guild}] /${commandName} failed`, error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
      }
    }
  } else {
    logger.warn(`Unknown command: /${commandName}`);
  }
});

// Plain-message chat: respond in DMs, or in guild channels when @mentioned.
client.on("messageCreate", async (message) => {
  try {
    await handleChatMessage(message);
  } catch (error) {
    logger.error("messageCreate handler error", error);
  }
});

// Reminder scheduler
async function checkReminders() {
  const dueReminders = getDueReminders();

  for (const reminder of dueReminders) {
    try {
      const channel = await client.channels.fetch(reminder.channelId).catch(() => null);
      if (channel && channel.isTextBased() && "send" in channel) {
        await channel.send(`<@${reminder.userId}> Reminder: ${reminder.message}`);
      }
    } catch (error) {
      logger.error(`Failed to send reminder ${reminder.id}`, error);
    }
    removeReminder(reminder.id);
  }
}

// Voice channel logging
client.on("voiceStateUpdate", async (oldState, newState) => {
  const guildId = newState.guild.id;
  const settings = getGuildSettings(guildId);

  if (!settings.voicelogChannel) return;

  const channel = await client.channels.fetch(settings.voicelogChannel).catch(() => null);
  if (!channel || !(channel instanceof TextChannel)) return;

  const member = newState.member;
  if (!member) return;

  const displayName = member.displayName;
  const username = member.user.username;

  let message: string | null = null;

  if (!oldState.channelId && newState.channelId) {
    // Joined a voice channel
    message = `**${displayName}** (${username}) joined <#${newState.channelId}>`;
  } else if (oldState.channelId && !newState.channelId) {
    // Left a voice channel
    message = `**${displayName}** (${username}) left <#${oldState.channelId}>`;
  } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    // Switched voice channels
    message = `**${displayName}** (${username}) moved <#${oldState.channelId}> → <#${newState.channelId}>`;
  }

  if (message) {
    channel.send(message).catch((err) => {
      logger.error(`Failed to send voicelog message`, err);
    });
  }
});

// Dashboard, JSON API and health endpoint (LAN-only, no auth)
const server = startWebServer(client);

// Graceful shutdown
function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down...`);

  // stop all cron jobs
  cron.stopAll();

  // stop accepting new connections
  server.close(() => logger.success("Web server closed"));

  // close discord client
  void client.destroy();

  logger.success("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

void client.login(config.DISCORD_TOKEN);
