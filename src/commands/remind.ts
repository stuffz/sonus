import { ChatInputCommandInteraction, SlashCommandBuilder, MessageFlags } from "discord.js";
import { addReminder, getUserTimezone } from "../lib/storage";
import * as chrono from "chrono-node";

export const data = new SlashCommandBuilder()
  .setName("remind")
  .setDescription("Set a reminder")
  .addStringOption((option) =>
    option
      .setName("when")
      .setDescription("When to remind you (e.g., 5min, in 2 hours, tomorrow 3pm)")
      .setRequired(true),
  )
  .addStringOption((option) => option.setName("message").setDescription("What to remind you about").setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction) {
  const timezone = getUserTimezone(interaction.user.id);

  if (!timezone) {
    return interaction.reply({
      content: "You need to set your timezone first. Use `/timezone set` to configure it.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const whenStr = interaction.options.getString("when", true);
  const message = interaction.options.getString("message", true);

  // Create a reference date in the user's timezone
  const now = new Date();
  const refDate = new Date(now.toLocaleString("en-US", { timeZone: timezone }));

  // Parse with chrono using the reference date
  const parsed = chrono.parseDate(whenStr, refDate, { forwardDate: true });

  if (!parsed) {
    return interaction.reply({
      content:
        "Couldn't understand that time. Try something like:\n• `5min` or `2h`\n• `in 2 hours`\n• `tomorrow at 3pm`\n• `friday 5pm`",
      flags: MessageFlags.Ephemeral,
    });
  }

  // Convert the parsed time back to UTC
  // The parsed date is in the user's timezone, we need the actual timestamp
  const userNow = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
  const offset = userNow.getTime() - now.getTime();
  const triggerAt = parsed.getTime() - offset;

  if (triggerAt <= Date.now()) {
    return interaction.reply({
      content: "That time is in the past. Please specify a future time.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const reminder = addReminder({
    userId: interaction.user.id,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    message,
    triggerAt,
  });

  const triggerTimestamp = Math.floor(reminder.triggerAt / 1000);
  return interaction.reply({
    content: `Reminder set for <t:${triggerTimestamp}:R> (<t:${triggerTimestamp}:f>)\n> ${message}`,
    flags: MessageFlags.Ephemeral,
  });
}
