import { ChatInputCommandInteraction, SlashCommandBuilder, MessageFlags, GuildMember } from "discord.js";
import { startListening } from "../lib/voice/index";
import { isFeatureEnabled } from "../lib/features";
import { logger } from "../lib/logger";

export const data = new SlashCommandBuilder()
  .setName("listen")
  .setDescription("Join your voice channel and start listening (explicit activation)");

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!isFeatureEnabled("aiVoice")) {
    return interaction.reply({
      content: "🔴 The Voice AI feature is currently disabled.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const member = interaction.member as GuildMember;
  if (!interaction.guildId || !interaction.guild) {
    return interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
  }

  const voiceChannel = member.voice?.channel;
  if (!voiceChannel) {
    return interaction.reply({
      content: "Join a voice channel first, then run `/listen`.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply();
  try {
    const channel = interaction.channel;
    const textChannel = channel && channel.isSendable() ? channel : undefined;
    await startListening(voiceChannel, textChannel);
    return interaction.editReply(
      `🎤 Listening in **${voiceChannel.name}**. Say **"Jarvis"** to ask me something (e.g. *"Jarvis, when's the next match?"*) — I only reply when addressed by name, and I remember the last few exchanges for follow-ups. Use \`/leave\` to stop.`,
    );
  } catch (error) {
    logger.error("[voice] /listen failed", error);
    return interaction.editReply(`Failed to join: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
