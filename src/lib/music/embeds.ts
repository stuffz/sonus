import { EmbedBuilder } from "discord.js";
import type { Song } from "distube";

/**
 * Format seconds into MM:SS or HH:MM:SS
 * @param seconds The time in seconds
 * @param forceHours If true, always include hours (for matching long duration formats)
 */
export function formatTime(seconds: number, forceHours: boolean = false): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0 || forceHours) {
    return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Create a "Now Playing" embed for the given song
 * @param song The song to display
 * @param isBackground Whether this is a background playlist song
 * @param currentTime Optional current playback time in seconds
 */
export function createNowPlayingEmbed(song: Song, isBackground: boolean = false, currentTime?: number): EmbedBuilder {
  // Build progress string - show 00:00 or 0:00:00 based on song length
  let progressStr: string;
  if (song.duration) {
    const forceHours = song.duration >= 3600;
    const elapsed = formatTime(currentTime ?? 0, forceHours);
    progressStr = `${elapsed} / ${song.formattedDuration}`;
  } else {
    progressStr = song.formattedDuration ?? "Unknown";
  }

  return new EmbedBuilder()
    .setTitle(isBackground ? "🔀 Now Playing (Background)" : "🎶 Now Playing")
    .setColor(isBackground ? 0x9b59b6 : 0x5865f2) // Purple for background, blue for regular
    .setDescription(`**${song.name}**`)
    .addFields(
      { name: "Progress", value: progressStr, inline: true },
      { name: "Requested by", value: song.user?.username ?? (isBackground ? "Background" : "Unknown"), inline: true },
      ...(song.url ? [{ name: "Video", value: `[YouTube](${song.url})`, inline: true }] : []),
    )
    .setThumbnail(song.thumbnail ?? null);
}
