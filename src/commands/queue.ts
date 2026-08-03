import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from "discord.js";
import { getPlayer } from "../lib/music/index";

const SONGS_PER_PAGE = 10;

export const data = new SlashCommandBuilder()
  .setName("queue")
  .setDescription("Queue management")
  .addSubcommand((sub) => sub.setName("list").setDescription("Show the current queue"))
  .addSubcommand((sub) => sub.setName("shuffle").setDescription("Shuffle the queue"))
  .addSubcommand((sub) => sub.setName("clear").setDescription("Clear upcoming songs (keeps current song playing)"));

function buildQueueEmbed(songs: { name?: string; formattedDuration?: string }[], page: number): EmbedBuilder {
  const current = songs[0];
  const upcoming = songs.slice(1);
  const totalPages = Math.max(1, Math.ceil(upcoming.length / SONGS_PER_PAGE));
  const startIdx = page * SONGS_PER_PAGE;
  const pageItems = upcoming.slice(startIdx, startIdx + SONGS_PER_PAGE);

  const description = [`🎵 **Now Playing:** ${current.name} - \`${current.formattedDuration}\``, ""];

  if (upcoming.length === 0) {
    description.push("*Queue is empty*");
  } else {
    description.push(`📋 **Up Next** (${upcoming.length} song${upcoming.length === 1 ? "" : "s"}):`);
    description.push("");
    pageItems.forEach((s, i) => {
      description.push(`**${startIdx + i + 1}.** ${s.name} - \`${s.formattedDuration}\``);
    });
  }

  return new EmbedBuilder()
    .setTitle("Queue")
    .setColor(0x5865f2)
    .setDescription(description.join("\n"))
    .setFooter(upcoming.length > 0 ? { text: `Page ${page + 1}/${totalPages}` } : null);
}

function buildPaginationButtons(page: number, totalPages: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("queue_prev")
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId("queue_page")
      .setLabel(`${page + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId("queue_next")
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();

  if (!interaction.guildId || !interaction.guild) {
    return interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
  }

  const distube = getPlayer();
  const queue = distube.getQueue(interaction.guildId);

  if (!queue) {
    return interaction.reply({ content: "Nothing is playing.", flags: MessageFlags.Ephemeral });
  }

  if (subcommand === "shuffle") {
    await queue.shuffle();
    return interaction.reply("Queue shuffled.");
  }

  if (subcommand === "clear") {
    if (queue.songs.length <= 1) {
      return interaction.reply({ content: "Queue is already empty.", flags: MessageFlags.Ephemeral });
    }

    // Keep only the current song
    queue.songs.splice(1);
    return interaction.reply("Cleared upcoming songs from the queue.");
  }

  if (subcommand === "list") {
    const songs = queue.songs;
    const upcoming = songs.slice(1);
    const totalPages = Math.max(1, Math.ceil(upcoming.length / SONGS_PER_PAGE));
    let currentPage = 0;

    const embed = buildQueueEmbed(songs, currentPage);
    const components = totalPages > 1 ? [buildPaginationButtons(currentPage, totalPages)] : [];

    const response = await interaction.reply({
      embeds: [embed],
      components,
      fetchReply: true,
    });

    if (totalPages <= 1) return;

    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 120000, // 2 minute timeout
    });

    collector.on("collect", async (buttonInteraction) => {
      // Only the command user can use the buttons
      if (buttonInteraction.user.id !== interaction.user.id) {
        await buttonInteraction.reply({
          content: "Only the person who ran this command can use these buttons.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Refresh queue state in case it changed
      const currentQueue = distube.getQueue(interaction.guildId!);
      if (!currentQueue) {
        await buttonInteraction.update({
          content: "Queue no longer exists.",
          embeds: [],
          components: [],
        });
        collector.stop();
        return;
      }

      const currentSongs = currentQueue.songs;
      const currentUpcoming = currentSongs.slice(1);
      const newTotalPages = Math.max(1, Math.ceil(currentUpcoming.length / SONGS_PER_PAGE));

      if (buttonInteraction.customId === "queue_prev") {
        currentPage = Math.max(0, currentPage - 1);
      } else if (buttonInteraction.customId === "queue_next") {
        currentPage = Math.min(newTotalPages - 1, currentPage + 1);
      }

      // Clamp page to valid range
      currentPage = Math.min(currentPage, newTotalPages - 1);

      const newEmbed = buildQueueEmbed(currentSongs, currentPage);
      const newComponents = newTotalPages > 1 ? [buildPaginationButtons(currentPage, newTotalPages)] : [];

      await buttonInteraction.update({
        embeds: [newEmbed],
        components: newComponents,
      });
    });

    collector.on("end", async () => {
      try {
        await interaction.editReply({ components: [] });
      } catch {
        // Message may have been deleted
      }
    });
  }
}
