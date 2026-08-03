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

const rest = new REST({ version: "10" }).setToken(token);

// Get the client ID by fetching the current application
const app = (await rest.get(Routes.oauth2CurrentApplication())) as { id: string; name: string };
console.log(`Clearing commands for ${app.name} (${app.id})...`);

// Clear global commands
await rest.put(Routes.applicationCommands(app.id), { body: [] });
console.log("Global commands cleared.");

// Clear guild commands
const guilds = (await rest.get(Routes.userGuilds())) as { id: string; name: string }[];
console.log(`Clearing commands from ${guilds.length} guild(s)...`);

for (const guild of guilds) {
  try {
    await rest.put(Routes.applicationGuildCommands(app.id, guild.id), { body: [] });
    console.log(`  Cleared: ${guild.name}`);
  } catch {
    console.log(`  Failed: ${guild.name} (missing permissions)`);
  }
}

console.log("Done. Global changes may take up to 1 hour to propagate.");
