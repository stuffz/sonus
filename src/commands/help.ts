import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from "discord.js";

export const data = new SlashCommandBuilder().setName("help").setDescription("List all available commands");

export async function execute(interaction: ChatInputCommandInteraction) {
  // Import here to avoid circular dependency
  const { commands } = await import("./commands");

  const embed = new EmbedBuilder()
    .setTitle("Available Commands")
    .setColor(0x5865f2)
    .setDescription(
      Object.entries(commands)
        .filter(([, cmd]) => !cmd.hidden)
        .map(([name, cmd]) => {
          const description = "description" in cmd.data ? cmd.data.description : "No description";
          return `**/${name}** - ${description}`;
        })
        .join("\n"),
    );

  return interaction.reply({ embeds: [embed] });
}
