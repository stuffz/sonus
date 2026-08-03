import { logger } from "../logger";
import { config } from "../config";
import { searchYouTubeVideoUrl } from "./ytdlp";

// Spotify URL patterns
const SPOTIFY_TRACK_REGEX = /^https?:\/\/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/;
const SPOTIFY_PLAYLIST_REGEX = /^https?:\/\/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/;
const SPOTIFY_ALBUM_REGEX = /^https?:\/\/open\.spotify\.com\/album\/([a-zA-Z0-9]+)/;

export function isSpotifyPlaylistUrl(url: string): boolean {
  return SPOTIFY_PLAYLIST_REGEX.test(url);
}

// --- Spotify Web API (Authorization Code / Refresh Token) ---

let spotifyAccessToken: string | null = null;
let spotifyTokenExpiry = 0;

/**
 * Check if Spotify API credentials are configured.
 * Requires client ID, client secret, and a refresh token from the OAuth flow.
 * Run `npx tsx scripts/spotify-auth.ts` to get the refresh token.
 */
export function hasSpotifyCredentials(): boolean {
  return !!(config.SPOTIFY_CLIENT_ID && config.SPOTIFY_CLIENT_SECRET && config.SPOTIFY_REFRESH_TOKEN);
}

/**
 * Get a Spotify access token using the refresh token.
 * Tokens are cached and refreshed automatically.
 */
async function getSpotifyToken(): Promise<string> {
  if (!hasSpotifyCredentials()) {
    throw new Error(
      "Spotify API credentials not configured. Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REFRESH_TOKEN. " +
        "Run `npx tsx scripts/spotify-auth.ts` to get a refresh token.",
    );
  }

  // Return cached token if still valid (with 60s buffer)
  if (spotifyAccessToken && Date.now() < spotifyTokenExpiry - 60_000) {
    return spotifyAccessToken;
  }

  const credentials = Buffer.from(`${config.SPOTIFY_CLIENT_ID}:${config.SPOTIFY_CLIENT_SECRET}`).toString("base64");

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(config.SPOTIFY_REFRESH_TOKEN)}`,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Spotify token refresh failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  spotifyAccessToken = data.access_token;
  spotifyTokenExpiry = Date.now() + data.expires_in * 1000;

  logger.debug("[Spotify] Refreshed access token");
  return spotifyAccessToken;
}

interface SpotifyTrackItem {
  // New API format: track data is under .item
  item?: {
    name: string;
    artists: Array<{ name: string }>;
    duration_ms: number;
    is_local: boolean;
  } | null;
  // Legacy API format: track data is under .track
  track?: {
    name: string;
    artists: Array<{ name: string }>;
    duration_ms: number;
    is_local: boolean;
  } | null;
  is_local?: boolean;
}

interface SpotifyPaginatedList {
  items: SpotifyTrackItem[];
  next: string | null;
  total: number;
}

interface SpotifyPlaylistResponse {
  name: string;
  // New API: tracks are under .items
  items?: SpotifyPaginatedList;
  // Legacy API: tracks are under .tracks
  tracks?: SpotifyPaginatedList;
}

/**
 * Fetch all tracks from a Spotify playlist.
 * Uses the full playlist endpoint with a user-scoped token.
 * Handles both old (.tracks/.track) and new (.items/.item) Spotify API formats.
 * Returns track search queries ("Artist - Title") and the playlist name.
 */
export async function fetchSpotifyPlaylist(url: string): Promise<{ queries: string[]; title: string }> {
  const match = url.match(SPOTIFY_PLAYLIST_REGEX);
  if (!match) throw new Error("Invalid Spotify playlist URL");
  const playlistId = match[1];

  const token = await getSpotifyToken();
  const queries: string[] = [];

  // Fetch full playlist (metadata + first page of tracks)
  const response = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("Spotify playlist not found.");
    }
    if (response.status === 403) {
      throw new Error("Cannot access this Spotify playlist. It may be private or restricted.");
    }
    throw new Error(`Spotify API error (${response.status}): ${await response.text()}`);
  }

  const playlist = (await response.json()) as SpotifyPlaylistResponse;
  const title = playlist.name || "Unknown Playlist";

  // Spotify API change: tracks moved from .tracks to .items
  const trackList = playlist.items ?? playlist.tracks;
  if (!trackList?.items) {
    throw new Error(
      "Could not retrieve tracks from this playlist. " +
        "It may be restricted by Spotify. Try a different playlist or one you own.",
    );
  }

  // Process first page
  for (const item of trackList.items) {
    const query = extractTrackQuery(item);
    if (query) queries.push(query);
  }

  // Paginate through remaining tracks
  let nextUrl = trackList.next;
  while (nextUrl) {
    const pageToken = await getSpotifyToken();
    const pageResponse = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${pageToken}` },
    });

    if (!pageResponse.ok) {
      logger.warn(`[Spotify] Pagination error (${pageResponse.status}), stopping at ${queries.length} tracks`);
      break;
    }

    const page = (await pageResponse.json()) as SpotifyPaginatedList;
    for (const item of page.items) {
      const query = extractTrackQuery(item);
      if (query) queries.push(query);
    }
    nextUrl = page.next;
  }

  if (queries.length === 0) {
    throw new Error("Playlist appears to be empty — no playable tracks found.");
  }

  logger.info(`[Spotify] Fetched ${queries.length} tracks from playlist "${title}"`);
  return { queries, title };
}

function extractTrackQuery(entry: SpotifyTrackItem): string | null {
  // New API format: track data under .item
  const track = entry.item ?? entry.track;
  if (!track) return null;
  if (track.is_local || entry.is_local) return null;
  const artist = track.artists.map((a) => a.name).join(", ");
  // Title first, then artist — matches YouTube's search ranking better
  return `${track.name} ${artist}`;
}

/**
 * Check if a URL is a Spotify URL
 */
export function isSpotifyUrl(url: string): boolean {
  return SPOTIFY_TRACK_REGEX.test(url) || SPOTIFY_PLAYLIST_REGEX.test(url) || SPOTIFY_ALBUM_REGEX.test(url);
}

interface IDHSResponse {
  id: string;
  type: string;
  title: string;
  description: string;
  links: Array<{
    type: string;
    url: string;
    isVerified?: boolean;
  }>;
}

// Rate limiting for IDHS API (10 requests per minute)
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10;
const requestTimestamps: number[] = [];

// In-memory cache for Spotify -> YouTube conversions
// Key: Spotify URL, Value: { youtubeUrl, timestamp }
const spotifyCache = new Map<string, { youtubeUrl: string; timestamp: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 500;

/**
 * Get cached YouTube URL for a Spotify URL
 */
function getCachedConversion(spotifyUrl: string): string | null {
  const cached = spotifyCache.get(spotifyUrl);
  if (!cached) return null;

  // Check if expired
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    spotifyCache.delete(spotifyUrl);
    return null;
  }

  return cached.youtubeUrl;
}

/**
 * Cache a Spotify -> YouTube conversion
 */
function cacheConversion(spotifyUrl: string, youtubeUrl: string): void {
  // Evict oldest entries if cache is full
  if (spotifyCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = spotifyCache.keys().next().value;
    if (oldestKey) spotifyCache.delete(oldestKey);
  }

  spotifyCache.set(spotifyUrl, { youtubeUrl, timestamp: Date.now() });
}

/**
 * Check if we can make a request without exceeding rate limit
 * Returns the number of seconds to wait, or 0 if request can proceed
 */
function getRateLimitWaitTime(): number {
  const now = Date.now();
  // Remove timestamps older than the window
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    // Calculate how long until the oldest request expires
    const oldestTimestamp = requestTimestamps[0];
    const waitMs = oldestTimestamp + RATE_LIMIT_WINDOW_MS - now;
    return Math.ceil(waitMs / 1000);
  }

  return 0;
}

/**
 * Record a request for rate limiting
 */
function recordRequest(): void {
  requestTimestamps.push(Date.now());
}

export class SpotifyConversionError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "SpotifyConversionError";
  }
}

/**
 * Fetch a single Spotify track's metadata via the Spotify Web API and return
 * a "Title Artist" search query. Returns null for local tracks.
 */
async function fetchSpotifyTrackQuery(spotifyUrl: string): Promise<string | null> {
  const match = spotifyUrl.match(SPOTIFY_TRACK_REGEX);
  if (!match) return null;
  const trackId = match[1];

  const token = await getSpotifyToken();
  const response = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Spotify API error (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as {
    name: string;
    artists: Array<{ name: string }>;
    is_local?: boolean;
  };

  if (data.is_local) return null;
  const artist = data.artists.map((a) => a.name).join(", ");
  return `${data.name} ${artist}`;
}

/**
 * Try resolving a Spotify track to YouTube using the Spotify Web API + yt-dlp
 * search. Mirrors the background-playlist path. Returns null on any failure
 * so the caller can fall back to the external IDHS service.
 */
async function convertSpotifyTrackViaApi(spotifyUrl: string): Promise<string | null> {
  if (!hasSpotifyCredentials()) return null;

  let query: string | null;
  try {
    query = await fetchSpotifyTrackQuery(spotifyUrl);
  } catch (err) {
    logger.warn(`[Spotify] Web API track fetch failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }

  if (!query) return null;

  const youtubeUrl = await searchYouTubeVideoUrl(`${query} song`);
  if (!youtubeUrl) {
    logger.warn(`[Spotify] YouTube search failed for: "${query}"`);
    return null;
  }

  logger.info(`[Spotify] (API) Converted: ${query} -> ${youtubeUrl}`);
  return youtubeUrl;
}

/**
 * Resolve a Spotify track to a YouTube URL.
 * Tries the Spotify Web API + yt-dlp search first (same path as the background
 * playlist). Falls back to idonthavespotify.sjdonado.com if that fails or no
 * Spotify credentials are configured.
 */
async function convertSpotifyToYouTube(spotifyUrl: string): Promise<string> {
  // Check cache first
  const cached = getCachedConversion(spotifyUrl);
  if (cached) {
    logger.debug(`[Spotify] Cache hit for ${spotifyUrl}`);
    return cached;
  }

  // Primary: Spotify Web API + yt-dlp search (IDHS is often down)
  const apiResult = await convertSpotifyTrackViaApi(spotifyUrl);
  if (apiResult) {
    cacheConversion(spotifyUrl, apiResult);
    return apiResult;
  }

  // Fallback: idonthavespotify.sjdonado.com (no API key, rate limit: 10 req/min)
  logger.debug(`[Spotify] Falling back to idonthavespotify for ${spotifyUrl}`);
  return convertSpotifyToYouTubeViaIDHS(spotifyUrl);
}

/**
 * Use idonthavespotify.sjdonado.com API to convert Spotify URL to YouTube.
 * No API key required, rate limit: 10 req/min. Used as a fallback when the
 * Spotify Web API path fails.
 */
async function convertSpotifyToYouTubeViaIDHS(spotifyUrl: string): Promise<string> {
  // Check rate limit before making request
  const waitTime = getRateLimitWaitTime();
  if (waitTime > 0) {
    throw new SpotifyConversionError(`Rate limited. Please try again in ${waitTime} seconds.`, waitTime);
  }

  recordRequest();

  let response: Response;
  try {
    response = await fetch("https://idonthavespotify.sjdonado.com/api/search?v=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        link: spotifyUrl,
        adapters: ["youTube"],
      }),
    });
  } catch (error) {
    logger.error(`[Spotify] Network error: ${error}`);
    throw new SpotifyConversionError("Failed to connect to Spotify conversion service. Please try again later.");
  }

  // Handle HTTP errors
  if (!response.ok) {
    if (response.status === 429) {
      // Server-side rate limit
      const retryAfter = parseInt(response.headers.get("Retry-After") || "60", 10);
      logger.warn(`[Spotify] Server rate limited, retry after ${retryAfter}s`);
      throw new SpotifyConversionError(
        `Rate limited by service. Please try again in ${retryAfter} seconds.`,
        retryAfter,
      );
    }
    if (response.status === 404) {
      throw new SpotifyConversionError("Track not found. The Spotify link may be invalid or the track is unavailable.");
    }
    if (response.status >= 500) {
      logger.error(`[Spotify] Server error: ${response.status}`);
      throw new SpotifyConversionError(
        "Spotify conversion service is temporarily unavailable. Please try again later.",
      );
    }
    logger.error(`[Spotify] API error: ${response.status}`);
    throw new SpotifyConversionError(`Failed to convert Spotify link (error ${response.status}).`);
  }

  let data: IDHSResponse;
  try {
    data = (await response.json()) as IDHSResponse;
  } catch {
    logger.error("[Spotify] Invalid JSON response");
    throw new SpotifyConversionError("Received invalid response from conversion service.");
  }

  const youtubeLink = data.links?.find((l) => l.type === "youTube");
  if (!youtubeLink?.url) {
    throw new SpotifyConversionError("Couldn't find this track on YouTube. Try searching for it directly.");
  }

  // Cache the successful conversion
  cacheConversion(spotifyUrl, youtubeLink.url);

  logger.info(`[Spotify] Converted: ${data.title} -> ${youtubeLink.url}`);
  return youtubeLink.url;
}

/**
 * Resolve Spotify URL to YouTube URLs
 * Tracks: Spotify Web API + yt-dlp search first, falls back to idonthavespotify.sjdonado.com
 * Playlists: Uses Spotify Web API (requires SPOTIFY_CLIENT_ID/SECRET)
 */
export async function resolveSpotifyToYouTube(spotifyUrl: string): Promise<string[]> {
  const isTrack = SPOTIFY_TRACK_REGEX.test(spotifyUrl);
  const isPlaylist = SPOTIFY_PLAYLIST_REGEX.test(spotifyUrl);
  const isAlbum = SPOTIFY_ALBUM_REGEX.test(spotifyUrl);

  if (isAlbum) {
    throw new Error("Spotify albums are not currently supported. Please share playlist or track links.");
  }

  if (isPlaylist) {
    if (!hasSpotifyCredentials()) {
      throw new Error("Spotify playlist support requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to be set.");
    }
    // Playlist fetching is handled via fetchSpotifyPlaylist() for background playlists.
    // For direct play, we'd need to resolve each track - not ideal for large playlists.
    throw new Error(
      "Use `/music background set <url>` to set a Spotify playlist as background music. For individual songs, share track links.",
    );
  }

  if (isTrack) {
    // convertSpotifyToYouTube throws SpotifyConversionError with user-friendly messages
    const youtubeUrl = await convertSpotifyToYouTube(spotifyUrl);
    return [youtubeUrl];
  }

  throw new Error("Invalid Spotify URL");
}
