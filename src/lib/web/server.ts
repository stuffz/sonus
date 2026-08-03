import http from "http";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Client } from "discord.js";
import { config } from "../config";
import { logger } from "../logger";
import { getPlayer, skipCurrentSong } from "../music/index";
import { FEATURES, isFeatureEnabled, setFeature, toggleFeature } from "../features";
import {
  getRuntimeStats,
  getMusicStats,
  getFeatureStats,
  getStorageStats,
  getCronStats,
  getGuildSummaries,
  getGuildDetail,
} from "../stats";

// Dashboard + JSON API on the same port as the /health endpoint.
// Deliberately unauthenticated: the port is only exposed on the LAN and the
// API is meant to be consumable by other local services.

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = join(__dirname, "..", "..", "web", "dashboard.html");

// Live stream cadence.
const SSE_INTERVAL_MS = 2000;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Params = Record<string, string>;
type RouteHandler = (params: Params, body: unknown) => unknown;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

const MUSIC_ACTIONS = ["skip", "stop", "pause", "resume"] as const;
type MusicAction = (typeof MUSIC_ACTIONS)[number];

function isMusicAction(value: string): value is MusicAction {
  return (MUSIC_ACTIONS as readonly string[]).includes(value);
}

function buildRoutes(client: Client): Route[] {
  const route = (method: string, path: string, handler: RouteHandler): Route => ({
    method,
    segments: path.split("/").filter(Boolean),
    handler,
  });

  const requireGuild = (guildId: string) => {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new HttpError(404, "Unknown guild");
    return guild;
  };

  return [
    route("GET", "/api/status", async () => ({
      runtime: getRuntimeStats(client),
      music: await getMusicStats(client),
      features: getFeatureStats(),
      storage: getStorageStats(),
      cron: getCronStats(),
    })),

    route("GET", "/api/guilds", () => getGuildSummaries(client)),

    route("GET", "/api/guilds/:id", (params) => getGuildDetail(requireGuild(params.id))),

    // Set a feature explicitly with body {"enabled": true|false}, or toggle with no body.
    route("POST", "/api/features/:key", (params, body) => {
      const feature = FEATURES.find((f) => f.key === params.key);
      if (!feature) throw new HttpError(404, "Unknown feature");
      if (!feature.configured()) throw new HttpError(409, "Feature is not configured");

      const enabled = (body as { enabled?: unknown } | null)?.enabled;
      let state: boolean;
      if (typeof enabled === "boolean") {
        setFeature(feature.key, enabled);
        state = enabled;
      } else if (enabled === undefined) {
        state = toggleFeature(feature.key);
      } else {
        throw new HttpError(400, '"enabled" must be a boolean');
      }
      logger.info(`[web] feature ${feature.key} → ${state ? "ON" : "OFF"}`);
      return { key: feature.key, enabled: isFeatureEnabled(feature.key) };
    }),

    // Reorder the queue: move the upcoming song at index `from` to index `to`
    // (absolute queue indices; 0 is the playing song and can't be moved).
    // Optional `name` guards against acting on a stale queue view.
    // Registered before the generic :action route — matching is first-wins.
    route("POST", "/api/guilds/:id/music/move", (params, body) => {
      const guild = requireGuild(params.id);
      let queue;
      try {
        queue = getPlayer().queues.get(guild.id);
      } catch {
        throw new HttpError(409, "Music player not initialized");
      }
      if (!queue) throw new HttpError(409, "Nothing is playing in this guild");

      const { from, to, name } = (body ?? {}) as { from?: unknown; to?: unknown; name?: unknown };
      const maxIndex = queue.songs.length - 1;
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        throw new HttpError(400, '"from" and "to" must be integers');
      }
      const fromIdx = from as number;
      const toIdx = to as number;
      if (fromIdx < 1 || fromIdx > maxIndex || toIdx < 1 || toIdx > maxIndex) {
        throw new HttpError(400, `indices must be between 1 and ${maxIndex} (0 is the playing song)`);
      }
      if (typeof name === "string" && queue.songs[fromIdx].name !== name) {
        throw new HttpError(409, "Queue changed since this view was rendered");
      }

      if (fromIdx !== toIdx) {
        const [song] = queue.songs.splice(fromIdx, 1);
        queue.songs.splice(toIdx, 0, song);
      }
      logger.info(`[web] music move ${fromIdx} → ${toIdx} in ${guild.name}`);
      return { ok: true, from: fromIdx, to: toIdx };
    }),

    route("POST", "/api/guilds/:id/music/:action", async (params) => {
      const guild = requireGuild(params.id);
      const action = params.action;
      if (!isMusicAction(action)) throw new HttpError(404, "Unknown action");

      let queue;
      try {
        queue = getPlayer().queues.get(guild.id);
      } catch {
        throw new HttpError(409, "Music player not initialized");
      }
      if (!queue) throw new HttpError(409, "Nothing is playing in this guild");

      let outcome: string = action;
      switch (action) {
        case "skip":
          // Shared with /skip — rolls into the background playlist when the queue runs dry.
          outcome = await skipCurrentSong(queue);
          break;
        case "stop":
          await queue.stop();
          break;
        case "pause":
          if (!queue.paused) await queue.pause();
          break;
        case "resume":
          if (queue.paused) await queue.resume();
          break;
      }
      logger.info(`[web] music ${action} in ${guild.name} → ${outcome}`);
      return { ok: true, action, outcome };
    }),
  ];
}

function matchRoute(routes: Route[], method: string, pathname: string): { route: Route; params: Params } | null {
  const segments = pathname.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== segments.length) continue;
    const params: Params = {};
    let matched = true;
    for (let i = 0; i < segments.length; i++) {
      const pattern = route.segments[i];
      if (pattern.startsWith(":")) params[pattern.slice(1)] = decodeURIComponent(segments[i]);
      else if (pattern !== segments[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
      if (raw.length > 64 * 1024) reject(new HttpError(413, "Body too large"));
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

export function startWebServer(client: Client): http.Server {
  const routes = buildRoutes(client);

  // --- Live updates (SSE) ---
  // Full snapshot every SSE_INTERVAL_MS while anyone is connected, plus an
  // immediate push after every mutating request so actions reflect instantly.
  const sseClients = new Set<http.ServerResponse>();
  let sseTimer: NodeJS.Timeout | null = null;

  async function buildSnapshot(): Promise<unknown> {
    return {
      status: {
        runtime: getRuntimeStats(client),
        music: await getMusicStats(client),
        features: getFeatureStats(),
        storage: getStorageStats(),
        cron: getCronStats(),
      },
      guilds: client.guilds.cache.map((guild) => getGuildDetail(guild)),
    };
  }

  async function broadcast(): Promise<void> {
    if (sseClients.size === 0) return;
    try {
      const payload = `data: ${JSON.stringify(await buildSnapshot())}\n\n`;
      for (const res of sseClients) res.write(payload);
    } catch (error) {
      logger.error("[web] failed to build SSE snapshot", error);
    }
  }

  function addSseClient(res: http.ServerResponse, req: http.IncomingMessage): void {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    sseClients.add(res);
    void buildSnapshot().then((snapshot) => res.write(`data: ${JSON.stringify(snapshot)}\n\n`));

    if (!sseTimer) {
      sseTimer = setInterval(() => void broadcast(), SSE_INTERVAL_MS);
    }

    req.on("close", () => {
      sseClients.delete(res);
      if (sseClients.size === 0 && sseTimer) {
        clearInterval(sseTimer);
        sseTimer = null;
      }
    });
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  server.on("close", () => {
    if (sseTimer) clearInterval(sseTimer);
    for (const res of sseClients) res.end();
    sseClients.clear();
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    const method = req.method ?? "GET";

    // Open CORS so other LAN services and pages can consume the API directly.
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      // Keep /health exactly as before (docker-compose healthcheck relies on it).
      if (method === "GET" && url.pathname === "/health") {
        const isReady = client.isReady();
        sendJson(res, isReady ? 200 : 503, {
          status: isReady ? "healthy" : "starting",
          uptime: process.uptime(),
          guilds: client.guilds.cache.size,
        });
        return;
      }

      if (method === "GET" && url.pathname === "/") {
        const html = await readFile(DASHBOARD_PATH, "utf-8");
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
        return;
      }

      if (method === "GET" && url.pathname === "/api/events") {
        addSseClient(res, req);
        return;
      }

      const match = matchRoute(routes, method, url.pathname);
      if (!match) {
        sendJson(res, 404, { error: "Not Found" });
        return;
      }

      const body = method === "POST" ? await readBody(req) : null;
      const result = await match.route.handler(match.params, body);
      sendJson(res, 200, result);
      // Push the new state to dashboard viewers right away.
      if (method === "POST") void broadcast();
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
      } else {
        logger.error(`[web] ${method} ${url.pathname} failed`, error);
        sendJson(res, 500, { error: "Internal Server Error" });
      }
    }
  }

  server.listen(config.HEALTH_PORT);
  logger.info(`Web server (dashboard + API + health) running on port ${config.HEALTH_PORT}`);
  return server;
}
