import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} from "discord.js";
import { getGuildSettings, setGuildSettings } from "../lib/storage";

export const data = new SlashCommandBuilder()
  .setName("voicelog")
  .setDescription("Configure voice channel logging")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Set the channel for voice logs")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("The text channel to log voice activity")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) => sub.setName("disable").setDescription("Disable voice logging"))
  .addSubcommand((sub) => sub.setName("status").setDescription("Show current voicelog configuration"));

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    return interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
  }

  const subcommand = interaction.options.getSubcommand();
  const settings = getGuildSettings(interaction.guildId);

  if (subcommand === "set") {
    const channel = interaction.options.getChannel("channel", true);
    setGuildSettings(interaction.guildId, { voicelogChannel: channel.id });
    return interaction.reply({ content: `Voice logs will be sent to <#${channel.id}>`, flags: MessageFlags.Ephemeral });
  }

  if (subcommand === "disable") {
    setGuildSettings(interaction.guildId, { voicelogChannel: undefined });
    return interaction.reply({ content: "Voice logging has been disabled.", flags: MessageFlags.Ephemeral });
  }

  if (subcommand === "status") {
    if (settings.voicelogChannel) {
      return interaction.reply({
        content: `Voice logs are sent to <#${settings.voicelogChannel}>`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.reply({ content: "Voice logging is not configured.", flags: MessageFlags.Ephemeral });
  }
}
