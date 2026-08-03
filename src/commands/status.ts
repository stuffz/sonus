import {
  ChatInputCommandInteraction,
  ButtonInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import { config } from "../lib/config";
import { getRuntimeStats, getMusicStats, getFeatureStats, getStorageStats, getCronStats } from "../lib/stats";
import { FEATURES, isFeatureEnabled, toggleFeature, type FeatureKey } from "../lib/features";
import { logger } from "../lib/logger";

export const data = new SlashCommandBuilder().setName("status").setDescription("Bot status and statistics");

export const hidden = true;

// Embed colors
const Colors = {
  Runtime: 0x3498db, // Blue
  Music: 0x2ecc71, // Green
  Features: 0x9b59b6, // Purple
  Storage: 0x1abc9c, // Teal
  Cron: 0xe67e22, // Orange
};

// customId prefix so the global interaction handler can route these buttons here.
const BTN = "status";

type StatusInteraction = ChatInputCommandInteraction | ButtonInteraction;

function isAdmin(interaction: StatusInteraction): boolean {
  return config.ADMIN_IDS.includes(interaction.user.id);
}

/** Build the full status message (embeds + control buttons). Shared by /status and its buttons. */
async function buildStatusMessage(
  interaction: StatusInteraction,
): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }> {
  const embeds: EmbedBuilder[] = [];

  // Runtime Embed
  const runtime = getRuntimeStats(interaction.client);
  const uptime = runtime.uptimeSeconds;
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);

  const uptimeStr = [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`, `${seconds}s`]
    .filter(Boolean)
    .join(" ");

  const heapMB = (runtime.heapUsedBytes / 1024 / 1024).toFixed(2);
  const rssMB = (runtime.rssBytes / 1024 / 1024).toFixed(2);

  const runtimeEmbed = new EmbedBuilder()
    .setTitle("🖥️ Runtime")
    .setColor(Colors.Runtime)
    .addFields(
      { name: "Uptime", value: uptimeStr, inline: true },
      { name: "Heap", value: `${heapMB} MB`, inline: true },
      { name: "RSS", value: `${rssMB} MB`, inline: true },
      { name: "Guilds", value: `${runtime.guilds}`, inline: true },
      { name: "Users", value: `${runtime.users}`, inline: true },
      { name: "Ping", value: `${runtime.pingMs}ms`, inline: true },
      { name: "Node", value: runtime.nodeVersion, inline: true },
    );
  embeds.push(runtimeEmbed);

  // Music Embed
  const music = await getMusicStats(interaction.client);
  if (music.playerReady) {
    const ytdlpStatus = music.ytdlp.upToDate
      ? `${music.ytdlp.current} ✅`
      : `${music.ytdlp.current} (${music.ytdlp.latest} available)`;

    const musicEmbed = new EmbedBuilder()
      .setTitle("🎵 Music")
      .setColor(Colors.Music)
      .addFields(
        { name: "Active Voice", value: `${music.activeVoice}`, inline: true },
        { name: "Queued Songs", value: `${music.queuedSongs}`, inline: true },
        {
          name: "BG Playlists",
          value: `${music.backgroundEnabled}/${music.backgroundConfigured} active`,
          inline: true,
        },
        { name: "yt-dlp", value: ytdlpStatus, inline: true },
      );
    embeds.push(musicEmbed);
  }

  // Features Embed — live state of the runtime toggles (controlled by the buttons below).
  const featureStats = getFeatureStats();

  const featureLines = featureStats.features.map((f) => {
    if (!f.configured) return `${f.emoji} ${f.name}: ⚪ Not configured`;
    return `${f.emoji} ${f.name}: ${f.enabled ? "🟢 On" : "🔴 Off"}`;
  });

  const featuresEmbed = new EmbedBuilder()
    .setTitle("⚙️ Features")
    .setColor(Colors.Features)
    .setDescription(featureLines.join("\n"))
    .addFields(
      {
        name: "Ollama",
        value: featureStats.ollamaModel ? `\`${featureStats.ollamaModel}\`` : "Not configured",
        inline: true,
      },
      { name: "Quote Files", value: `${featureStats.quoteCommands}`, inline: true },
    );
  embeds.push(featuresEmbed);

  // Storage Embed
  const storage = getStorageStats();

  const storageEmbed = new EmbedBuilder()
    .setTitle("💾 Storage")
    .setColor(Colors.Storage)
    .addFields(
      { name: "Guilds Configured", value: `${storage.guildsConfigured}`, inline: true },
      { name: "Voicelog Enabled", value: `${storage.voicelogEnabled}`, inline: true },
      { name: "Music Channel Set", value: `${storage.musicChannelSet}`, inline: true },
      { name: "Users w/ Timezone", value: `${storage.usersWithTimezone}`, inline: true },
      { name: "Pending Reminders", value: `${storage.pendingReminders}`, inline: true },
    );
  embeds.push(storageEmbed);

  // Cron Embed
  const cronJobs = getCronStats();
  if (cronJobs.length > 0) {
    const cronLines = cronJobs.map((job) => {
      const lastRunStr = job.lastRun ? `<t:${Math.floor(job.lastRun / 1000)}:R>` : "Never";
      const nextRunStr = `<t:${Math.floor(job.nextRun / 1000)}:R>`;
      return `**${job.name}**\nLast: ${lastRunStr} • Next: ${nextRunStr}`;
    });

    const cronEmbed = new EmbedBuilder()
      .setTitle("⏰ Cron Jobs")
      .setColor(Colors.Cron)
      .setDescription(cronLines.join("\n\n"));
    embeds.push(cronEmbed);
  }

  // Add timestamp to last embed
  embeds[embeds.length - 1].setTimestamp();

  return { embeds, components: buildComponents() };
}

/** Toggle buttons (one per feature) + an action row. Green = on, red = off, grey = not configured. */
function buildComponents(): ActionRowBuilder<ButtonBuilder>[] {
  const toggleRow = new ActionRowBuilder<ButtonBuilder>();
  for (const f of FEATURES) {
    const configured = f.configured();
    const on = isFeatureEnabled(f.key);
    toggleRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`${BTN}:toggle:${f.key}`)
        .setLabel(f.label)
        .setEmoji(f.emoji)
        .setStyle(!configured ? ButtonStyle.Secondary : on ? ButtonStyle.Success : ButtonStyle.Danger)
        .setDisabled(!configured),
    );
  }

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BTN}:refresh`)
      .setLabel("Refresh")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary),
  );

  return [toggleRow, actionRow];
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({
      content: "You don't have permission to use this command.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const { embeds, components } = await buildStatusMessage(interaction);
  return interaction.reply({ embeds, components, flags: MessageFlags.Ephemeral });
}

/** Routed here from the global interaction handler for any button whose customId starts with "status:". */
export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (!isAdmin(interaction)) {
    await interaction.reply({
      content: "You don't have permission to use these controls.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const [, action, key] = interaction.customId.split(":");

  if (action === "toggle" && key) {
    const feature = FEATURES.find((f) => f.key === key);
    if (feature && feature.configured()) {
      const state = toggleFeature(key as FeatureKey);
      logger.info(`[status] ${interaction.user.username} toggled ${key} → ${state ? "ON" : "OFF"}`);
    }
  }
  // "refresh" (and any toggle) falls through to a re-render of the message.

  const { embeds, components } = await buildStatusMessage(interaction);
  await interaction.update({ embeds, components });
}
