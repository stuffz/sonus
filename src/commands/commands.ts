import { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";
import { discoverQuoteCommands } from "../lib/quotes";
import { logger } from "../lib/logger";
import * as ask from "./ask";
import * as help from "./help";
import * as status from "./status";
import * as voicelog from "./voicelog";
import * as remind from "./remind";
import * as reminders from "./reminders";
import * as timezone from "./timezone";
import * as music from "./music";
import * as play from "./play";
import * as skip from "./skip";
import * as stop from "./stop";
import * as queue from "./queue";
import * as listen from "./listen";
import * as leave from "./leave";

export interface Command {
  data: { name: string; description?: string; toJSON?: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<unknown>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
  hidden?: boolean;
}

const coreCommands: Record<string, Command> = {
  ask,
  help,
  status,
  voicelog,
  remind,
  reminders,
  timezone,
  music,
  play,
  skip,
  stop,
  queue,
  listen,
  leave,
};

const quoteCommands = discoverQuoteCommands();

// Check for collisions
for (const name of quoteCommands.keys()) {
  if (coreCommands[name]) {
    logger.error(`Quote command "${name}" collides with core command. Skipping quote.`);
    quoteCommands.delete(name);
  }
}

// Merge commands
export const commands: Record<string, Command> = {
  ...coreCommands,
  ...Object.fromEntries(quoteCommands),
};
