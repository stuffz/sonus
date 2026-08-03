import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ComponentType,
} from "discord.js";
import { getUserReminders, removeReminder } from "../lib/storage";

export const data = new SlashCommandBuilder().setName("reminders").setDescription("View and manage your reminders");

export async function execute(interaction: ChatInputCommandInteraction) {
  const reminders = getUserReminders(interaction.user.id);

  if (reminders.length === 0) {
    return interaction.reply({
      content: "You have no pending reminders.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const sorted = reminders.sort((a, b) => a.triggerAt - b.triggerAt);

  const list = sorted
    .map((r, i) => {
      const timestamp = Math.floor(r.triggerAt / 1000);
      return `**${i + 1}.** <t:${timestamp}:R> (<t:${timestamp}:f>)\n> ${r.message}`;
    })
    .join("\n\n");

  // Create cancel buttons (max 5 per row, max 5 rows = 25 buttons)
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const maxButtons = Math.min(sorted.length, 25);

  for (let i = 0; i < maxButtons; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (let j = i; j < Math.min(i + 5, maxButtons); j++) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`cancel_reminder_${sorted[j].id}`)
          .setLabel(`Cancel #${j + 1}`)
          .setStyle(ButtonStyle.Secondary),
      );
    }
    rows.push(row);
  }

  const response = await interaction.reply({
    content: `**Your reminders:**\n\n${list}`,
    components: rows,
    flags: MessageFlags.Ephemeral,
  });

  // Handle button clicks
  const collector = response.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60000, // 1 minute timeout
  });

  collector.on("collect", async (buttonInteraction: ButtonInteraction) => {
    if (!buttonInteraction.customId.startsWith("cancel_reminder_")) return;

    const reminderId = buttonInteraction.customId.replace("cancel_reminder_", "");
    const reminder = getUserReminders(interaction.user.id).find((r) => r.id === reminderId);

    if (!reminder) {
      await buttonInteraction.reply({
        content: "Reminder not found or already cancelled.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    removeReminder(reminderId);

    // Update the message with the new list
    const updatedReminders = getUserReminders(interaction.user.id);

    if (updatedReminders.length === 0) {
      await buttonInteraction.update({
        content: "All reminders cancelled.",
        components: [],
      });
      collector.stop();
      return;
    }

    const updatedSorted = updatedReminders.sort((a, b) => a.triggerAt - b.triggerAt);
    const updatedList = updatedSorted
      .map((r, i) => {
        const timestamp = Math.floor(r.triggerAt / 1000);
        return `**${i + 1}.** <t:${timestamp}:R> (<t:${timestamp}:f>)\n> ${r.message}`;
      })
      .join("\n\n");

    // Rebuild buttons
    const updatedRows: ActionRowBuilder<ButtonBuilder>[] = [];
    const updatedMaxButtons = Math.min(updatedSorted.length, 25);

    for (let i = 0; i < updatedMaxButtons; i += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      for (let j = i; j < Math.min(i + 5, updatedMaxButtons); j++) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`cancel_reminder_${updatedSorted[j].id}`)
            .setLabel(`Cancel #${j + 1}`)
            .setStyle(ButtonStyle.Secondary),
        );
      }
      updatedRows.push(row);
    }

    await buttonInteraction.update({
      content: `**Your reminders:**\n\n${updatedList}`,
      components: updatedRows,
    });
  });

  collector.on("end", async () => {
    // Remove buttons after timeout
    try {
      await interaction.editReply({ components: [] });
    } catch {
      // Message may have been deleted
    }
  });
}
