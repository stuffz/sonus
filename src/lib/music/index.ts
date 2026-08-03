// Re-export all music functionality from submodules
export {
  checkYtDlpUpdate,
  getYtDlpVersion,
  getLatestYtDlpVersion,
  searchYouTube,
  searchYouTubeVideoUrl,
  fetchPlaylistEntries,
} from "./ytdlp";

export {
  isSpotifyUrl,
  isSpotifyPlaylistUrl,
  hasSpotifyCredentials,
  fetchSpotifyPlaylist,
  resolveSpotifyToYouTube,
  SpotifyConversionError,
} from "./spotify";

export {
  isBackgroundMode,
  setBackgroundActive,
  getBackgroundState,
  cacheBackgroundPlaylist,
  updateBackgroundCache,
  clearBackgroundPlaylist,
  getNextBackgroundSongUrl,
  playRandomBackground,
  refreshAllBackgroundPlaylists,
  type BackgroundState,
} from "./background";

export { formatTime, createNowPlayingEmbed } from "./embeds";

export {
  initMusic,
  getPlayer,
  setMusicChannel,
  getMusicChannel,
  checkLonelyVoiceChannels,
  attemptMusicRecovery,
  cleanupBrokenQueue,
  skipCurrentSong,
  type SkipOutcome,
} from "./player";
