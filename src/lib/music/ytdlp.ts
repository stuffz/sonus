import { existsSync } from "fs";
import path from "path";
import { spawn } from "child_process";
import { download as downloadYtDlp } from "@distube/yt-dlp";
import { logger } from "../logger";
import {
  formatTrack,
  isConfidentMatch,
  pickBestMatch,
  SKIP_TITLE_PATTERN,
  type MatchCandidate,
  type TrackInfo,
} from "./match";

// Optional cookies file for YouTube authentication
const cookiesPath = path.join(process.cwd(), "data", "cookies.txt");
const hasCookies = existsSync(cookiesPath);
if (hasCookies) {
  process.env.YTDLP_COOKIES = cookiesPath;
  logger.info(`YouTube cookies loaded from ${cookiesPath}`);
}

/** Common yt-dlp args: cookies from env */
function commonArgs(): string[] {
  const args: string[] = [];
  if (hasCookies) args.push("--cookies", cookiesPath);
  return args;
}

// Path to yt-dlp binary
export const ytDlpPath = path.join(
  process.cwd(),
  "node_modules",
  "@distube",
  "yt-dlp",
  "bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
);

// GitHub API URL for yt-dlp releases (used by status command)
const YTDLP_RELEASES_URL = "https://api.github.com/repos/yt-dlp/yt-dlp/releases?per_page=1";

/**
 * Get the currently installed yt-dlp version
 */
export async function getYtDlpVersion(): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(ytDlpPath, ["--version"]);
    let output = "";
    proc.stdout.on("data", (data) => {
      output += data.toString();
    });
    proc.on("close", () => resolve(output.trim() || "unknown"));
    proc.on("error", () => resolve("unknown"));
  });
}

/**
 * Get the latest yt-dlp version from GitHub
 */
export async function getLatestYtDlpVersion(): Promise<string> {
  try {
    const response = await fetch(YTDLP_RELEASES_URL, {
      headers: { "User-Agent": "sonus-bot" },
    });
    if (!response.ok) return "unknown";
    const [release] = (await response.json()) as Array<{ tag_name: string }>;
    return release?.tag_name ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Check for yt-dlp updates and download if available
 * Returns true if an update was performed
 */
export async function checkYtDlpUpdate(): Promise<boolean> {
  try {
    const currentVersion = await getYtDlpVersion();
    if (currentVersion === "unknown") {
      logger.debug("Could not check yt-dlp version");
      return false;
    }

    const result = await selfUpdate();
    if (result.updated) {
      logger.info(`yt-dlp updated: ${currentVersion} -> ${result.version}`);
      return true;
    }

    logger.debug(`yt-dlp is up to date (${currentVersion})`);
    return false;
  } catch (err) {
    logger.warn("Failed to check/update yt-dlp", err);
    return false;
  }
}

/**
 * Update yt-dlp binary using its native --update mechanism.
 * Falls back to @distube/yt-dlp download() if --update fails.
 */
export async function updateYtDlp(): Promise<string> {
  try {
    const result = await selfUpdate();
    logger.info(`yt-dlp ${result.updated ? "updated to" : "already at"} ${result.version}`);
    return result.version;
  } catch {
    // Fall back to @distube/yt-dlp download if self-update fails (e.g. first install)
    logger.info("Self-update failed, falling back to @distube/yt-dlp download");
    const version = await downloadYtDlp();
    // downloadYtDlp() doesn't await its writeFile — give it time
    await new Promise((resolve) => setTimeout(resolve, 2000));
    logger.info(`yt-dlp downloaded: ${version}`);
    return version;
  }
}

/**
 * Run yt-dlp --update and parse the output
 */
function selfUpdate(): Promise<{ updated: boolean; version: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath, ["--update"], { timeout: 30000 });
    let output = "";

    proc.stdout.on("data", (data) => {
      output += data.toString();
    });
    proc.stderr.on("data", (data) => {
      output += data.toString();
    });

    proc.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp --update exited with code ${code}: ${output}`));
        return;
      }

      const updated = output.includes("Updating to") || output.includes("Updated yt-dlp");
      const version = await getYtDlpVersion();
      resolve({ updated, version });
    });

    proc.on("error", (err) => reject(err));
  });
}

/**
 * Search YouTube using yt-dlp and return the first video URL
 * DisTube's YtDlpPlugin doesn't handle ytsearch: queries well,
 * so we do the search ourselves and pass the resolved URL
 */
export async function searchYouTube(query: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = [
      `ytsearch:${query}`,
      "--get-url",
      "--no-warnings",
      "--no-playlist",
      "-f",
      "bestaudio/best",
      ...commonArgs(),
    ];

    const proc = spawn(ytDlpPath, args, { timeout: 15000 });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        // yt-dlp with --get-url returns the direct stream URL, not the video URL
        // We need to get the video ID instead
        resolve(stdout.trim().split("\n")[0]);
      } else {
        logger.warn(`YouTube search failed for "${query}": ${stderr}`);
        resolve(null);
      }
    });

    proc.on("error", (error) => {
      logger.error(`YouTube search process error: ${error.message}`);
      resolve(null);
    });
  });
}

/** How many search results to look at when picking a video. */
const SEARCH_RESULT_COUNT = 5;

export type SearchResult = MatchCandidate;

/**
 * Pick the first search result whose title doesn't match SKIP_TITLE_PATTERN.
 * Falls back to the first result when every result matches, so a search never comes up empty.
 */
export function pickSearchResult(results: SearchResult[]): SearchResult | null {
  if (results.length === 0) return null;
  return results.find((r) => !SKIP_TITLE_PATTERN.test(r.title)) ?? results[0];
}

const MUSIC_SEARCH_URL = "https://music.youtube.com/search";
const MUSIC_SONGS_SECTION = "#songs";
const OEMBED_URL = "https://www.youtube.com/oembed";
const OEMBED_TIMEOUT_MS = 5000;

/**
 * Added to the regular YouTube search only, as /play has always done. The Songs section
 * lists only songs anyway, and with the suffix it dropped RED's original "Let Go" from its
 * top 5 in a live comparison.
 */
const SONG_SEARCH_SUFFIX = " song";

/**
 * Find a Spotify track on YouTube and return the video URL.
 *
 * Searches the Songs section of YouTube Music, which holds tracks rather than clickbait
 * videos sharing a few keywords, but also covers and edits by other uploaders. Results
 * are matched on artist and title (see pickBestMatch). When none is a confident match,
 * because the track is missing from YouTube Music or listed under an artist name we can't
 * match, a regular YouTube search is matched alongside them and the best of both wins.
 */
export async function searchYouTubeMusicUrl(track: TrackInfo): Promise<string | null> {
  const query = `${track.title} ${track.artists.join(", ")}`;
  const musicTarget = `${MUSIC_SEARCH_URL}?q=${encodeURIComponent(query)}${MUSIC_SONGS_SECTION}`;
  const songs = await addUploaders(await runSearch(query, musicTarget, "YouTube Music"));
  let match = pickBestMatch(track, songs);

  if (!isConfidentMatch(match)) {
    const videoQuery = `${query}${SONG_SEARCH_SUFFIX}`;
    const videos = await runSearch(videoQuery, `ytsearch${SEARCH_RESULT_COUNT}:${videoQuery}`, "YouTube");
    match = pickBestMatch(track, [...songs, ...videos]);
  }

  if (!match) {
    return null;
  }

  const { id, title, uploader } = match.candidate;
  const summary =
    `"${formatTrack(track)}" -> ${id} (${title} by ${uploader ?? "unknown"}, ` +
    `artist match: ${match.artistMatch}, title score ${match.titleScore.toFixed(2)})`;
  if (isConfidentMatch(match)) {
    logger.info(`[YouTube Music] Match ${summary}`);
  } else {
    logger.warn(`[YouTube Music] No confident match, using best guess ${summary}`);
  }
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * Search YouTube and return the video URL (not the stream URL).
 * Skips results with "Music Video" in the title (see pickSearchResult).
 */
export async function searchYouTubeVideoUrl(query: string): Promise<string | null> {
  const results = await runSearch(query, `ytsearch${SEARCH_RESULT_COUNT}:${query}`, "YouTube");
  const pick = pickSearchResult(results);
  if (!pick) {
    return null;
  }

  const skipped = results.indexOf(pick);
  if (skipped > 0) {
    logger.info(`[YouTube] Skipped ${skipped} music video result(s) for "${query}"`);
  } else if (SKIP_TITLE_PATTERN.test(pick.title)) {
    logger.info(`[YouTube] Every result for "${query}" is a music video, using the first`);
  }
  logger.info(`[YouTube] Search "${query}" -> ${pick.id} (${pick.title})`);
  return `https://www.youtube.com/watch?v=${pick.id}`;
}

/** Returns the top results, or an empty list (with a warning logged) when the search fails. */
function runSearch(query: string, target: string, label: string): Promise<SearchResult[]> {
  return new Promise((resolve) => {
    const args = [
      target,
      "--playlist-items",
      `1:${SEARCH_RESULT_COUNT}`,
      "--flat-playlist",
      "--print",
      // Flat YouTube Music results have no channel; "|" makes yt-dlp print "" instead of "NA".
      "%(id)s\t%(channel|)s\t%(title)s",
      "--no-warnings",
      ...commonArgs(),
    ];

    const proc = spawn(ytDlpPath, args, { timeout: 15000 });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      const results: SearchResult[] = stdout
        .trim()
        .split("\n")
        .map((line) => {
          const [id, uploader = "", ...title] = line.split("\t");
          return { id: id.trim(), title: title.join("\t"), uploader: uploader || null };
        })
        .filter((r) => r.id);

      if (code === 0 && results.length > 0) {
        resolve(results);
      } else {
        logger.warn(`[${label}] Search "${query}" -> no result: ${stderr}`);
        resolve([]);
      }
    });

    proc.on("error", (error) => {
      logger.error(`[${label}] Search process error: ${error.message}`);
      resolve([]);
    });
  });
}

/** Flat YouTube Music results have no uploader, which scoring needs to tell covers apart. */
async function addUploaders(results: SearchResult[]): Promise<SearchResult[]> {
  return Promise.all(results.map(async (r) => (r.uploader ? r : { ...r, uploader: await fetchUploader(r.id) })));
}

/** Uses oEmbed, a single cheap HTTP request, instead of a full yt-dlp extraction per result. */
async function fetchUploader(videoId: string): Promise<string | null> {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const response = await fetch(`${OEMBED_URL}?format=json&url=${encodeURIComponent(videoUrl)}`, {
      signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn(`[YouTube Music] oEmbed returned ${response.status} for ${videoId}`);
      return null;
    }

    const data = (await response.json()) as { author_name?: string };
    return data.author_name ?? null;
  } catch (err) {
    logger.warn(`[YouTube Music] oEmbed lookup failed for ${videoId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Fetch playlist entries using yt-dlp directly
 * Returns an array of video URLs and the playlist title
 */
export async function fetchPlaylistEntries(url: string): Promise<{ urls: string[]; title: string }> {
  return new Promise((resolve, reject) => {
    const args = [url, "--flat-playlist", "--dump-json", "--no-warnings", ...commonArgs()];

    const proc = spawn(ytDlpPath, args, { timeout: 60000 });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to fetch playlist: ${stderr}`));
        return;
      }

      const lines = stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim());
      if (lines.length === 0) {
        reject(new Error("Playlist is empty or not a valid playlist URL"));
        return;
      }

      const urls: string[] = [];
      let playlistTitle = "Unknown Playlist";

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          // Get playlist title from first entry if available
          if (entry.playlist_title && playlistTitle === "Unknown Playlist") {
            playlistTitle = entry.playlist_title;
          }
          // Prefer the full URL, fall back to building from video ID
          if (entry.url) {
            urls.push(entry.url);
          } else if (entry.id) {
            urls.push(`https://www.youtube.com/watch?v=${entry.id}`);
          }
        } catch {
          // Skip malformed JSON lines
        }
      }

      if (urls.length === 0) {
        reject(new Error("No valid entries found in playlist"));
        return;
      }

      resolve({ urls, title: playlistTitle });
    });

    proc.on("error", (error) => {
      reject(new Error(`Failed to fetch playlist: ${error.message}`));
    });
  });
}

export { hasCookies, cookiesPath };
