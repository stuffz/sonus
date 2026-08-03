import { readdirSync, readFileSync, existsSync } from "fs";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "node:url";
import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { logger } from "./logger";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const QUOTES_DIR = join(__dirname, "..", "..", "data", "quotes");

const cache = new Map<string, string[]>();

export function loadQuotes(name: string): string[] {
  if (cache.has(name)) {
    return cache.get(name)!;
  }

  const filePath = join(QUOTES_DIR, `${name}.json`);

  if (!existsSync(filePath)) {
    logger.warn(`Quotes file not found: ${filePath}`);
    return [];
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const quotes = JSON.parse(content) as string[];
    cache.set(name, quotes);
    logger.debug(`Loaded ${quotes.length} quotes from ${name}.json`);
    return quotes;
  } catch (error) {
    logger.error(`Failed to load quotes from ${name}.json`, error);
    return [];
  }
}

export function getRandomQuote(name: string): string | null {
  const quotes = loadQuotes(name);
  if (quotes.length === 0) {
    return null;
  }
  return quotes[Math.floor(Math.random() * quotes.length)];
}

export function getQuoteCommandsCount(): number {
  if (!existsSync(QUOTES_DIR)) {
    return 0;
  }
  return readdirSync(QUOTES_DIR).filter((f) => f.endsWith(".json")).length;
}

export interface QuoteCommand {
  data: ReturnType<SlashCommandBuilder["toJSON"]>;
  execute: (interaction: ChatInputCommandInteraction) => Promise<unknown>;
}

export function discoverQuoteCommands(): Map<string, QuoteCommand> {
  const commands = new Map<string, QuoteCommand>();

  if (!existsSync(QUOTES_DIR)) {
    logger.warn(`Quotes directory not found: ${QUOTES_DIR}`);
    return commands;
  }

  const files = readdirSync(QUOTES_DIR).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const name = basename(file, ".json");
    const quotes = loadQuotes(name);

    if (quotes.length === 0) {
      continue;
    }

    const data = new SlashCommandBuilder().setName(name).setDescription(`Random quote from ${name}`).toJSON();

    const execute = async (interaction: ChatInputCommandInteraction) => {
      const quote = getRandomQuote(name);
      if (!quote) {
        return interaction.reply(`No quotes available for ${name}.`);
      }
      return interaction.reply(quote);
    };

    commands.set(name, { data, execute });
    logger.info(`Registered quote command: /${name} (${quotes.length} quotes)`);
  }

  return commands;
}
