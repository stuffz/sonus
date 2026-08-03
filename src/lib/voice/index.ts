import type { VoiceBasedChannel } from "discord.js";
import { VoiceSession } from "./session";
import type { SendableTextChannel } from "./session";

// One active listening session per guild.
const sessions = new Map<string, VoiceSession>();

/** Join `channel` and begin listening. Replaces any existing session in that guild. */
export async function startListening(channel: VoiceBasedChannel, textChannel?: SendableTextChannel): Promise<void> {
  stopListening(channel.guild.id);
  const session = new VoiceSession(channel, textChannel);
  try {
    await session.awaitReady();
  } catch {
    session.destroy();
    throw new Error("could not connect to the voice channel in time");
  }
  sessions.set(channel.guild.id, session);
}

/** Stop and leave the session for a guild, if any. Returns true if one was active. */
export function stopListening(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;
  session.destroy();
  sessions.delete(guildId);
  return true;
}

export function isListening(guildId: string): boolean {
  return sessions.has(guildId);
}
