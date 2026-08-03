import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  MessageFlags,
  GuildMember,
  EmbedBuilder,
  TextChannel,
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import {
  getPlayer,
  setMusicChannel,
  cacheBackgroundPlaylist,
  clearBackgroundPlaylist,
  getBackgroundState,
  updateBackgroundCache,
  createNowPlayingEmbed,
  isBackgroundMode,
} from "../lib/music/index";
import { playRandomBackground } from "../lib/music/background";
import { getGuildSettings, setGuildSettings } from "../lib/storage";

export const data = new SlashCommandBuilder()
  .setName("music")
  .setDescription("Music playback controls")
  .addSubcommand((sub) => sub.setName("pause").setDescription("Pause the current song"))
  .addSubcommand((sub) => sub.setName("resume").setDescription("Resume the current song"))
  .addSubcommand((sub) => sub.setName("nowplaying").setDescription("Show the currently playing song"))
  .addSubcommand((sub) =>
    sub
      .setName("volume")
      .setDescription("Set the volume")
      .addIntegerOption((option) =>
        option
          .setName("level")
          .setDescription("Volume level (0-100)")
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(100),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("loop")
      .setDescription("Set loop mode")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("Loop mode")
          .setRequired(true)
          .addChoices(
            { name: "Off", value: "off" },
            { name: "Song", value: "song" },
            { name: "Queue", value: "queue" },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("setchannel")
      .setDescription("Lock music outputs to a specific channel")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Channel for music outputs (leave empty to use current channel)")
          .addChannelTypes(ChannelType.GuildText),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("clearchannel").setDescription("Remove the locked music channel (outputs go where command was used)"),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("background")
      .setDescription("Background playlist settings")
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription("Set a background playlist to play when queue is empty")
          .addStringOption((option) =>
            option.setName("url").setDescription("Playlist URL (Spotify or YouTube)").setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName("clear").setDescription("Remove the background playlist"))
      .addSubcommand((sub) => sub.setName("status").setDescription("Show current background playlist status"))
      .addSubcommand((sub) => sub.setName("update").setDescription("Re-fetch and update the cached playlist")),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();
  const subcommandGroup = interaction.options.getSubcommandGroup();
  const member = interaction.member as GuildMember;

  if (!interaction.guildId || !interaction.guild) {
    return interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
  }

  const distube = getPlayer();
  const queue = distube.getQueue(interaction.guildId);

  // Handle background subcommand group
  if (subcommandGroup === "background") {
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: "You need the Manage Server permission to use this command.",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === "set") {
      const url = interaction.options.getString("url", true);
      await interaction.deferReply();

      try {
        const result = await cacheBackgroundPlaylist(interaction.guildId, url);

        // Auto-start if user is in a voice channel and nothing is playing
        const voiceChannel = member.voice.channel;
        if (voiceChannel && !queue) {
          await playRandomBackground(
            distube,
            interaction.guildId,
            voiceChannel,
            interaction.channel instanceof TextChannel ? interaction.channel : undefined,
          );
          return interaction.editReply(
            `✅ Background playlist set: **${result.name}** (${result.count} songs)\n\n🎵 Started playing!`,
          );
        }

        return interaction.editReply(
          `✅ Background playlist set: **${result.name}** (${result.count} songs)\n\nWhen the queue is empty, a random song from this playlist will play.`,
        );
      } catch (error) {
        return interaction.editReply(
          `Failed to set background playlist: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    }

    if (subcommand === "clear") {
      clearBackgroundPlaylist(interaction.guildId);
      return interaction.reply("Background playlist cleared.");
    }

    if (subcommand === "status") {
      const settings = getGuildSettings(interaction.guildId);
      const state = getBackgroundState(interaction.guildId);

      if (!settings.backgroundPlaylist) {
        return interaction.reply({ content: "No background playlist configured.", flags: MessageFlags.Ephemeral });
      }

      const embed = new EmbedBuilder()
        .setTitle("Background Playlist")
        .setColor(0x5865f2)
        .addFields(
          { name: "Playlist", value: state?.playlistName ?? "Unknown", inline: true },
          { name: "Songs Cached", value: String(state?.songs.length ?? 0), inline: true },
          { name: "Enabled", value: settings.backgroundEnabled ? "Yes" : "No", inline: true },
          { name: "Currently Active", value: state?.isActive ? "Yes" : "No", inline: true },
        );

      return interaction.reply({ embeds: [embed] });
    }

    if (subcommand === "update") {
      await interaction.deferReply();

      try {
        const result = await updateBackgroundCache(interaction.guildId);
        return interaction.editReply(`✅ Background playlist updated: **${result.name}** (${result.count} songs)`);
      } catch (error) {
        return interaction.editReply(`Failed to update: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    return;
  }

  // Commands that require an active queue
  if (
    subcommand === "pause" ||
    subcommand === "resume" ||
    subcommand === "nowplaying" ||
    subcommand === "volume" ||
    subcommand === "loop"
  ) {
    if (!queue) {
      return interaction.reply({ content: "Nothing is playing.", flags: MessageFlags.Ephemeral });
    }
  }

  if (subcommand === "pause") {
    if (queue!.paused) {
      return interaction.reply({ content: "Already paused.", flags: MessageFlags.Ephemeral });
    }
    try {
      void queue!.pause();
    } catch {
      return interaction.reply({
        content: "Failed to pause — the player may be in a bad state. Try `/stop` and play again.",
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.reply("Paused.");
  }

  if (subcommand === "resume") {
    if (!queue!.paused) {
      return interaction.reply({ content: "Not paused.", flags: MessageFlags.Ephemeral });
    }
    try {
      void queue!.resume();
    } catch {
      // Stream likely died while paused (HTTP timeout) — skip to next or stop
      if (queue!.songs.length > 1) {
        try {
          await queue!.skip();
          return interaction.reply("The paused track's stream expired. Skipping to next song.");
        } catch {
          /* fall through to stop */
        }
      }
      try {
        void queue!.stop();
      } catch {
        /* ignore */
      }
      return interaction.reply(
        "The paused track's stream expired. Queue has been cleared — use `/play` to start again.",
      );
    }
    return interaction.reply("Resumed.");
  }

  if (subcommand === "nowplaying") {
    const song = queue!.songs[0];
    const isBackground = isBackgroundMode(interaction.guildId);
    const currentTime = queue!.currentTime;
    const embed = createNowPlayingEmbed(song, isBackground, currentTime);

    return interaction.reply({ embeds: [embed] });
  }

  if (subcommand === "volume") {
    const level = interaction.options.getInteger("level", true);
    queue!.setVolume(level);
    return interaction.reply(`Volume set to ${level}%`);
  }

  if (subcommand === "loop") {
    const mode = interaction.options.getString("mode", true);
    const modes = { off: 0, song: 1, queue: 2 } as const;
    queue!.setRepeatMode(modes[mode as keyof typeof modes]);
    return interaction.reply(`Loop mode: ${mode}`);
  }

  if (subcommand === "setchannel") {
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: "You need the Manage Server permission to use this command.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const channel = interaction.options.getChannel("channel") ?? interaction.channel;
    if (!channel || !(channel instanceof TextChannel)) {
      return interaction.reply({ content: "Invalid channel.", flags: MessageFlags.Ephemeral });
    }

    setGuildSettings(interaction.guildId, { musicChannel: channel.id });
    setMusicChannel(interaction.guildId, channel.id);
    return interaction.reply(`Music outputs will now be sent to <#${channel.id}>.`);
  }

  if (subcommand === "clearchannel") {
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: "You need the Manage Server permission to use this command.",
        flags: MessageFlags.Ephemeral,
      });
    }

    setGuildSettings(interaction.guildId, { musicChannel: undefined });
    setMusicChannel(interaction.guildId, undefined);
    return interaction.reply("Music output channel cleared. Messages will be sent where commands are used.");
  }
}
