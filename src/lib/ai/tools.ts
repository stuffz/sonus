import { config } from "../config";
import { logger } from "../logger";
import type { ToolSpec } from "./agent";

type WebResult = { title?: string; url?: string; content?: string };

/** web_search — self-hosted SearXNG. Context-free, so usable by both chat and voice. */
export const webSearchTool: ToolSpec = {
  def: {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for current, factual, or external information the user asks you to look up (news, facts, docs, prices, definitions, etc.). " +
        'Use when the user asks you to "find", "search", "look up", or asks about something you don\'t know or that may have changed since your training.',
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "the web search query" },
        },
        required: ["query"],
      },
    },
  },
  execute: async (args) => {
    const query = (typeof args.query === "string" ? args.query : "").trim();
    if (!query) return "Error: no search query was provided.";
    try {
      const url = `${config.SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`search backend returned ${res.status}`);
      const data = await res.json();
      const results: WebResult[] = (data.results ?? []).slice(0, 5);
      logger.info(`[tool] web_search ${JSON.stringify(query)} -> ${results.length} results`);
      if (!results.length) return `No web results found for "${query}".`;
      const formatted = results
        .map(
          (r, i) =>
            `${i + 1}. ${r.title ?? "(untitled)"}\n   ${r.url ?? ""}\n   ${(r.content ?? "").replace(/\s+/g, " ").slice(0, 300)}`,
        )
        .join("\n\n");
      return `Web search results for "${query}" (cite the URLs you actually use):\n\n${formatted}`;
    } catch (error) {
      logger.warn(`[tool] web_search failed: ${error instanceof Error ? error.message : error}`);
      return "Web search failed — the search service may be unavailable. Tell the user you couldn't reach the web right now.";
    }
  },
};
