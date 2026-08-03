import { ChatInputCommandInteraction, SlashCommandBuilder, MessageFlags, GuildMember, TextChannel } from "discord.js";
import { getPlayer, skipCurrentSong, type SkipOutcome } from "../lib/music/index";

export const data = new SlashCommandBuilder().setName("skip").setDescription("Skip the current song");

const MESSAGES: Record<SkipOutcome, string> = {
  skipped: "Skipped.",
  "background-next": "Skipped. Playing next background song...",
  "background-started": "Skipped. Starting background playlist...",
  empty: "Skipped. Queue is now empty.",
  "background-failed": "Failed to skip to next background song.",
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const member = interaction.member as GuildMember;

  if (!interaction.guildId || !interaction.guild) {
    return interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
  }

  const distube = getPlayer();
  const queue = distube.getQueue(interaction.guildId);

  if (!queue) {
    return interaction.reply({ content: "Nothing is playing.", flags: MessageFlags.Ephemeral });
  }

  // Skipping the last song may roll into the background playlist, which can take
  // a while (yt-dlp resolution) — defer so the interaction doesn't time out.
  const mayHitBackground = queue.songs.length <= 1;
  if (mayHitBackground) await interaction.deferReply();

  const outcome = await skipCurrentSong(queue, {
    member,
    textChannel: interaction.channel instanceof TextChannel ? interaction.channel : undefined,
  });

  const message = MESSAGES[outcome];
  return mayHitBackground ? interaction.editReply(message) : interaction.reply(message);
}
