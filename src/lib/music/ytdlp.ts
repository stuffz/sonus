import { existsSync } from "fs";
import path from "path";
import { spawn } from "child_process";
import { download as downloadYtDlp } from "@distube/yt-dlp";
import { logger } from "../logger";

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

/**
 * Search YouTube and return the video URL (not the stream URL)
 */
export async function searchYouTubeVideoUrl(query: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = [`ytsearch:${query}`, "--flat-playlist", "--print", "id", "--no-warnings", ...commonArgs()];

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
        const videoId = stdout.trim().split("\n")[0];
        logger.info(`[YouTube] Search "${query}" -> ${videoId}`);
        resolve(`https://www.youtube.com/watch?v=${videoId}`);
      } else {
        logger.warn(`[YouTube] Search "${query}" -> no result: ${stderr}`);
        resolve(null);
      }
    });

    proc.on("error", (error) => {
      logger.error(`YouTube search process error: ${error.message}`);
      resolve(null);
    });
  });
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
