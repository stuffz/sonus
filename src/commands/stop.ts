import { ChatInputCommandInteraction, SlashCommandBuilder, MessageFlags } from "discord.js";
import { getPlayer } from "../lib/music/index";

export const data = new SlashCommandBuilder().setName("stop").setDescription("Stop playing and clear the queue");

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId || !interaction.guild) {
    return interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
  }

  const distube = getPlayer();
  const queue = distube.getQueue(interaction.guildId);

  if (!queue) {
    return interaction.reply({ content: "Nothing is playing.", flags: MessageFlags.Ephemeral });
  }

  await queue.stop();
  return interaction.reply("Stopped and cleared the queue.");
}
