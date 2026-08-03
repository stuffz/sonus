import { ChatInputCommandInteraction, SlashCommandBuilder, MessageFlags, AutocompleteInteraction } from "discord.js";
import { getUserTimezone, setUserTimezone } from "../lib/storage";

const COMMON_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Vancouver",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Stockholm",
  "Europe/Helsinki",
  "Europe/Moscow",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Pacific/Auckland",
  "Pacific/Honolulu",
];

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const data = new SlashCommandBuilder()
  .setName("timezone")
  .setDescription("Set your timezone for reminders")
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Set your timezone")
      .addStringOption((option) =>
        option
          .setName("timezone")
          .setDescription("Your timezone (e.g., America/New_York, Europe/London)")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) => sub.setName("show").setDescription("Show your current timezone"));

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const filtered = COMMON_TIMEZONES.filter((tz) => tz.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((tz) => ({ name: tz, value: tz }));
  await interaction.respond(filtered);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "set") {
    const timezone = interaction.options.getString("timezone", true);

    if (!isValidTimezone(timezone)) {
      return interaction.reply({
        content: `Invalid timezone: \`${timezone}\`\nUse a valid IANA timezone like \`America/New_York\` or \`Europe/London\`.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    setUserTimezone(interaction.user.id, timezone);

    const now = new Date().toLocaleString("en-US", {
      timeZone: timezone,
      dateStyle: "full",
      timeStyle: "short",
    });

    return interaction.reply({
      content: `Timezone set to \`${timezone}\`\nCurrent time: ${now}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (subcommand === "show") {
    const timezone = getUserTimezone(interaction.user.id);

    if (!timezone) {
      return interaction.reply({
        content: "You haven't set a timezone yet. Use `/timezone set` to set one.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const now = new Date().toLocaleString("en-US", {
      timeZone: timezone,
      dateStyle: "full",
      timeStyle: "short",
    });

    return interaction.reply({
      content: `Your timezone: \`${timezone}\`\nCurrent time: ${now}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
