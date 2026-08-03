import { REST, Routes } from "discord.js";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

// Load .env file if DISCORD_TOKEN is not already set
if (!process.env.DISCORD_TOKEN) {
  const envPath = resolve(import.meta.dirname, "../.env");
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const [, key, value] = match;
        process.env[key.trim()] = value.trim().replace(/^["']|["']$/g, "");
      }
    }
  }
}

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN not set");
  process.exit(1);
}

// Import commands (has minor side effects: creates logs dir, discovers quote files)
const { commands } = await import("../src/commands/commands");

const rest = new REST({ version: "10" }).setToken(token);

// Get the client ID by fetching the current application
const app = (await rest.get(Routes.oauth2CurrentApplication())) as { id: string; name: string };

const commandsData = Object.values(commands).map((command: { data: { toJSON?: () => unknown } }) =>
  typeof command.data.toJSON === "function" ? command.data.toJSON() : command.data,
);

const commandNames = Object.keys(commands);
console.log(`Deploying ${commandNames.length} commands globally for ${app.name}...`);
console.log(`Commands: ${commandNames.join(", ")}`);

await rest.put(Routes.applicationCommands(app.id), { body: commandsData });

console.log("Done! Commands may take up to 1 hour to propagate to all guilds.");
