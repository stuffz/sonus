import { ChatInputCommandInteraction, SlashCommandBuilder, MessageFlags } from "discord.js";
import { buildSystemPrompt, chatCompletion, chunkText } from "../lib/ai/llm";
import { linkifyDates } from "../lib/chat/timestamps";
import { isFeatureEnabled } from "../lib/features";
import { logger } from "../lib/logger";

export const data = new SlashCommandBuilder()
  .setName("ask")
  .setDescription("Answer using AI (Ollama)!")
  .addStringOption((option) =>
    option.setName("question").setDescription("The question you want to ask").setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!isFeatureEnabled("aiAsk")) {
    return interaction.reply({
      content: "🔴 The AI `/ask` feature is currently disabled.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const question = interaction.options.getString("question", true);
  if (!question) {
    return interaction.reply("Please provide a question to ask.");
  }

  // Show as typing while waiting for the response
  await interaction.deferReply();
  try {
    const answer = linkifyDates(
      await chatCompletion([
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: question },
      ]),
    );

    // Discord caps a message at 2000 chars — first piece as the reply, rest as follow-ups.
    const chunks = chunkText(answer);
    await interaction.editReply(chunks[0]);
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp(chunk);
    }
    return;
  } catch (error) {
    logger.error("Error fetching response from Ollama:", error);
    return interaction.editReply("An error occurred while trying to get the answer. Please try again later.");
  }
}
