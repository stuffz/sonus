import { chatCompletionRaw, extractText } from "./llm";
import type { ChatMessage, ToolDef } from "./llm";

/** A tool the agent can call: its schema (shown to the model) + an executor. */
export type ToolSpec = {
  def: ToolDef;
  execute: (args: Record<string, unknown>) => Promise<string>;
};

/**
 * Run the model in a tool loop: it either answers directly or calls tools, whose results
 * are fed back until it produces text (or MAX_ITERATIONS is hit, after which tools are
 * dropped so it MUST answer). Reused by both the text-chat handler and the voice pipeline.
 */
export async function runAgent(opts: {
  system: string;
  user: string;
  history?: ChatMessage[];
  tools: ToolSpec[];
  maxIterations?: number;
  enableThinking?: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  log?: (msg: string) => void;
}): Promise<string> {
  const max = opts.maxIterations ?? 4;
  const log = opts.log ?? (() => {});
  const defs: ToolDef[] = opts.tools.map((t) => t.def);
  const byName = new Map(opts.tools.map((t) => [t.def.function.name, t.execute]));

  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    ...(opts.history ?? []),
    { role: "user", content: opts.user },
  ];

  for (let i = 0; i < max; i++) {
    const assistant = await chatCompletionRaw(messages, {
      tools: defs.length ? defs : undefined,
      enableThinking: opts.enableThinking,
      reasoningEffort: opts.reasoningEffort,
    });
    messages.push({ role: "assistant", content: assistant.content ?? "", tool_calls: assistant.tool_calls });

    if (!assistant.tool_calls?.length) {
      log(`✅ answered directly (iteration ${i + 1})`);
      return extractText(assistant);
    }

    for (const call of assistant.tool_calls) {
      log(`🔧 tool call: ${call.function.name} args=${call.function.arguments}`);
      const exec = byName.get(call.function.name);
      let result: string;
      if (!exec) {
        // Steer the model out of a retry loop, not just report the failure.
        const available = [...byName.keys()].join(", ") || "none";
        result = `Error: the tool "${call.function.name}" does not exist. Available tools: ${available}. Do not call it again — answer the user with what you already know.`;
      } else {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* ignore bad json */
        }
        try {
          result = await exec(args);
        } catch (e) {
          result = `Tool error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      messages.push({ role: "tool", content: result, tool_call_id: call.id });
    }
  }

  // Force a fast final answer: no tools AND thinking OFF — re-reasoning over the accumulated
  // tool results with thinking on is extremely slow (was ~37s in voice). Just synthesize.
  log(`⚠️ hit max iterations (${max}); forcing final answer (tools off, thinking off)`);
  return extractText(await chatCompletionRaw(messages, { enableThinking: false }));
}
