/**
 * Minimal OpenAI-compatible chat client.
 *
 * Deliberately not the official SDK: the surface we need is one POST to
 * /chat/completions with tools, and keeping it to a hand-rolled fetch means
 * Ollama, llama.cpp, vLLM, DeepInfra and friends all work without caring which
 * SDK version matches which provider's quirks.
 */

import { request } from "undici";
import { LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from "./config.ts";

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema. Kept flat and scalar — see `tools.ts`. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as the model emitted it; may be malformed. */
  argumentsJson: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ChatReply {
  content: string;
  toolCalls: ToolCall[];
}

export class LlmError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, name: m.name, content: m.content };
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls && m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((t) => ({
                id: t.id,
                type: "function",
                function: { name: t.name, arguments: t.argumentsJson },
              })),
            }
          : {}),
      };
    default:
      return { role: m.role, content: m.content };
  }
}

interface WireChoice {
  message?: {
    content?: string | null;
    tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
  };
}

export async function chat(args: {
  messages: ChatMessage[];
  tools?: ToolDef[];
  signal?: AbortSignal;
}): Promise<ChatReply> {
  const url = `${LLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model: LLM_MODEL,
    messages: args.messages.map(toWireMessage),
    // Low but not zero: deterministic enough to be predictable, not so rigid
    // that a stuck phrasing can never recover.
    temperature: 0.2,
    stream: false,
    ...(args.tools && args.tools.length > 0
      ? {
          tools: args.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
  };

  let res;
  try {
    res = await request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(LLM_API_KEY ? { authorization: `Bearer ${LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify(body),
      signal: args.signal ?? AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
  } catch (err) {
    throw new LlmError(
      `Can't reach the model at ${LLM_BASE_URL}. Is it running? (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const text = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new LlmError(`Model returned HTTP ${res.statusCode}: ${text.slice(0, 300)}`, res.statusCode);
  }

  let parsed: { choices?: WireChoice[] };
  try {
    parsed = JSON.parse(text) as { choices?: WireChoice[] };
  } catch {
    throw new LlmError(`Model returned non-JSON: ${text.slice(0, 200)}`);
  }

  const message = parsed.choices?.[0]?.message;
  const toolCalls: ToolCall[] = (message?.tool_calls ?? [])
    .map((t, i) => ({
      id: t.id ?? `call_${i}`,
      name: t.function?.name ?? "",
      argumentsJson: t.function?.arguments ?? "{}",
    }))
    .filter((t) => t.name !== "");

  return { content: stripReasoning(message?.content ?? ""), toolCalls };
}

export type StreamEvent =
  | { type: "token"; text: string }
  | { type: "toolCalls"; toolCalls: ToolCall[] }
  | { type: "end"; content: string; toolCalls: ToolCall[] };

/**
 * Streaming variant of `chat`, yielding deltas as they arrive.
 *
 * Needed because a 4B model on consumer hardware takes tens of seconds to
 * finish a reply, and waiting in silence for that reads as broken. The tokens
 * arrive at the same rate either way; showing them is the difference between
 * "slow" and "hung".
 *
 * Reasoning tokens are filtered out of the stream as they pass, so a hybrid
 * model's scratchpad never flickers into view before being cleaned up.
 */
export async function* chatStream(args: {
  messages: ChatMessage[];
  tools?: ToolDef[];
  signal?: AbortSignal;
}): AsyncGenerator<StreamEvent> {
  const url = `${LLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model: LLM_MODEL,
    messages: args.messages.map(toWireMessage),
    temperature: 0.2,
    stream: true,
    ...(args.tools && args.tools.length > 0
      ? {
          tools: args.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
  };

  let res;
  try {
    res = await request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(LLM_API_KEY ? { authorization: `Bearer ${LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify(body),
      signal: args.signal ?? AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
  } catch (err) {
    throw new LlmError(
      `Can't reach the model at ${LLM_BASE_URL}. Is it running? (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = await res.body.text();
    throw new LlmError(`Model returned HTTP ${res.statusCode}: ${text.slice(0, 300)}`, res.statusCode);
  }

  /** Tool call deltas arrive in fragments and are assembled by index. */
  const partialCalls = new Map<number, { id: string; name: string; args: string }>();
  let content = "";
  /** True while inside a <think> block, so its tokens are not emitted. */
  let inThink = false;
  let pending = "";
  let buffer = "";

  for await (const chunk of res.body) {
    buffer += chunk.toString();
    // SSE frames are newline-delimited; keep any trailing partial line.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;

      let parsed: {
        choices?: {
          delta?: {
            content?: string | null;
            tool_calls?: {
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
        }[];
      };
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue; // A partial or non-JSON keepalive frame.
      }

      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;

      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const existing = partialCalls.get(idx) ?? { id: "", name: "", args: "" };
        partialCalls.set(idx, {
          id: tc.id ?? existing.id,
          name: tc.function?.name ?? existing.name,
          args: existing.args + (tc.function?.arguments ?? ""),
        });
      }

      if (typeof delta.content === "string" && delta.content !== "") {
        content += delta.content;
        pending += delta.content;

        // Emit only text outside <think>...</think>, handling tags that
        // straddle chunk boundaries by holding back a possible partial tag.
        for (;;) {
          if (inThink) {
            const close = pending.indexOf("</think>");
            if (close === -1) {
              pending = pending.slice(Math.max(0, pending.length - 8));
              break;
            }
            pending = pending.slice(close + 8);
            inThink = false;
            continue;
          }
          const open = pending.indexOf("<think>");
          if (open === -1) {
            // Hold back enough to recognise a tag split across chunks.
            const safe = pending.length > 7 ? pending.slice(0, pending.length - 7) : "";
            if (safe) {
              yield { type: "token", text: safe };
              pending = pending.slice(safe.length);
            }
            break;
          }
          if (open > 0) yield { type: "token", text: pending.slice(0, open) };
          pending = pending.slice(open + 7);
          inThink = true;
        }
      }
    }
  }

  // Flush whatever was held back for tag detection.
  if (!inThink && pending) yield { type: "token", text: pending };

  const toolCalls: ToolCall[] = [...partialCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, argumentsJson: c.args || "{}" }))
    .filter((c) => c.name !== "");

  if (toolCalls.length > 0) yield { type: "toolCalls", toolCalls };
  yield { type: "end", content: stripReasoning(content), toolCalls };
}

/**
 * Remove a reasoning scratchpad from the visible reply.
 *
 * qwen3 is a hybrid reasoning model and can emit `<think>...</think>` inline.
 * Most of the time Ollama strips it, but not reliably across versions and
 * templates, and a leaked scratchpad shown as the answer is both confusing
 * and a privacy wart. Cheap to handle unconditionally.
 */
export function stripReasoning(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    // An unclosed block means the model was cut off mid-thought; drop the tail
    // rather than show it.
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

/**
 * Is a model endpoint reachable, and does it have the configured model?
 *
 * Asks the OpenAI-compatible `/models` list rather than running a completion.
 * The first version did run one, and reported "not reachable" against a
 * perfectly healthy Ollama: qwen3 is a reasoning model, so even "reply with
 * one word" takes longer than a liveness check should wait on CPU. Listing
 * models is instant and answers the more useful question anyway — whether the
 * *configured* model is actually installed, which a completion only tells you
 * by failing.
 */
export async function probeLlm(): Promise<{
  ok: boolean;
  model: string;
  detail: string;
  /** False when the endpoint is up but the configured model is not pulled. */
  modelInstalled?: boolean;
}> {
  const url = `${LLM_BASE_URL.replace(/\/+$/, "")}/models`;
  try {
    const res = await request(url, {
      method: "GET",
      headers: LLM_API_KEY ? { authorization: `Bearer ${LLM_API_KEY}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return { ok: false, model: LLM_MODEL, detail: `HTTP ${res.statusCode} from ${url}` };
    }

    const ids = new Set<string>();
    try {
      const parsed = JSON.parse(text) as { data?: { id?: string }[] };
      for (const m of parsed.data ?? []) if (m.id) ids.add(m.id);
    } catch {
      // Endpoint answered but not in the expected shape. It is clearly alive,
      // so treat that as reachable rather than failing on a format guess.
      return { ok: true, model: LLM_MODEL, detail: "reachable", modelInstalled: true };
    }

    // Ollama reports "qwen3:4b"; hosted providers often add a prefix or drop
    // the tag, so accept a prefix match rather than demanding equality.
    const installed =
      ids.has(LLM_MODEL) ||
      [...ids].some((id) => id.startsWith(LLM_MODEL) || LLM_MODEL.startsWith(id));

    return {
      ok: installed,
      model: LLM_MODEL,
      modelInstalled: installed,
      detail: installed
        ? "reachable"
        : `reachable, but "${LLM_MODEL}" is not installed. Available: ${[...ids].slice(0, 6).join(", ") || "none"}`,
    };
  } catch (err) {
    return {
      ok: false,
      model: LLM_MODEL,
      detail: `Can't reach ${LLM_BASE_URL} (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}
