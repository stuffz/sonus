import { ChatInputCommandInteraction, SlashCommandBuilder, MessageFlags } from "discord.js";
import { stopListening } from "../lib/voice/index";

export const data = new SlashCommandBuilder()
  .setName("leave")
  .setDescription("Leave the voice channel and stop listening");

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    return interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
  }
  const stopped = stopListening(interaction.guildId);
  return interaction.reply(stopped ? "👋 Left the voice channel." : "I'm not listening in any voice channel here.");
}
