import { ChatInputCommandInteraction, SlashCommandBuilder, MessageFlags, GuildMember, TextChannel } from "discord.js";
import {
  getPlayer,
  isBackgroundMode,
  setBackgroundActive,
  isSpotifyUrl,
  resolveSpotifyToYouTube,
  searchYouTubeVideoUrl,
  cleanupBrokenQueue,
} from "../lib/music/index";

// Check if a string is a URL
function isUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const data = new SlashCommandBuilder()
  .setName("play")
  .setDescription("Play a song or add to queue")
  .addStringOption((option) =>
    option.setName("query").setDescription("Song name or URL (YouTube, Spotify)").setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const member = interaction.member as GuildMember;

  if (!interaction.guildId || !interaction.guild) {
    return interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
  }

  const voiceChannel = member.voice.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: "You need to be in a voice channel.", flags: MessageFlags.Ephemeral });
  }

  const query = interaction.options.getString("query", true);
  await interaction.deferReply();

  try {
    const distube = getPlayer();

    // If in background mode, mark it as inactive so it won't continue after the user's songs finish
    if (isBackgroundMode(interaction.guildId)) {
      setBackgroundActive(interaction.guildId, false);
    }

    // If queue exists and is paused, resume it so the new song actually plays
    const existingQueue = distube.getQueue(interaction.guildId);
    if (existingQueue?.paused) {
      try {
        void existingQueue.resume();
      } catch {
        // If resume fails (e.g. stream died while paused), stop the broken queue
        // so distube.play() below creates a fresh one
        try {
          void existingQueue.stop();
        } catch {
          /* ignore */
        }
      }
    }

    // Handle Spotify URLs - resolve to YouTube first
    if (isSpotifyUrl(query)) {
      await interaction.editReply("🔍 Resolving Spotify track...");
      const youtubeUrls = await resolveSpotifyToYouTube(query);

      if (youtubeUrls.length === 0) {
        return interaction.editReply("❌ Couldn't find that track on YouTube.");
      }

      // Play first track, queue the rest
      for (let i = 0; i < youtubeUrls.length; i++) {
        await distube.play(voiceChannel, youtubeUrls[i], {
          member,
          textChannel: interaction.channel instanceof TextChannel ? interaction.channel : undefined,
        });

        // Status update for playlists
        if (youtubeUrls.length > 1 && i === 0) {
          await interaction.editReply(`🎵 Adding ${youtubeUrls.length} tracks from Spotify...`);
        }
      }

      await interaction.deleteReply();
    } else {
      // Regular YouTube URL or search query
      let playUrl: string;

      if (isUrl(query)) {
        // Direct URL - use as-is
        playUrl = query;
      } else {
        // Search query - resolve to YouTube URL first
        // DisTube's YtDlpPlugin doesn't handle ytsearch: well, so we search manually
        await interaction.editReply("🔍 Searching YouTube...");
        const searchResult = await searchYouTubeVideoUrl(`${query} song`);

        if (!searchResult) {
          return interaction.editReply(`❌ Couldn't find any results for "${query}"`);
        }
        playUrl = searchResult;
      }

      await distube.play(voiceChannel, playUrl, {
        member,
        textChannel: interaction.channel instanceof TextChannel ? interaction.channel : undefined,
      });
      await interaction.deleteReply();
    }
  } catch (error) {
    // Only clean up if the queue is in a broken (empty) state — don't nuke
    // a working queue that still has other songs
    cleanupBrokenQueue(interaction.guildId);
    await interaction.editReply(`Failed to play: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
