/**
 * Recovering tool calls that the model wrote as prose instead of emitting
 * through the tool-calling API.
 *
 * Small models are inconsistent about this. Observed live from qwen3:4b: the
 * same prompt produced a correct structured `tool_calls` on one turn and, on
 * the next, a reply whose entire body was
 *
 *     {"tool": "find_slots", "arguments": {"days": 7, "duration_minutes": 90}}
 *
 * with `tool_calls` empty. Without recovery that JSON goes straight to the
 * user as the answer, which is both useless and alarming.
 *
 * So: when a turn comes back with no structured tool calls, check whether the
 * content is really a tool call wearing a trenchcoat. Deliberately strict —
 * it must parse as JSON and name a known tool — because the cost of a false
 * positive (silently running a tool the model meant as illustration) is worse
 * than the cost of a miss (the user sees an odd reply and rephrases).
 */

import type { ToolCall } from "./llm.ts";

/** Strip a ```json ... ``` fence, if the model wrapped its output in one. */
function unfence(text: string): string {
  const fenced = /^\s*```(?:json|JSON)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(text);
  return fenced ? fenced[1]!.trim() : text.trim();
}

/**
 * Pull the first balanced top-level JSON object out of a string, so a call
 * buried in "Sure, I'll check: {...}" is still recoverable.
 */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** The key names different models use for "which tool" and "with what". */
const NAME_KEYS = ["tool", "name", "tool_name", "function", "function_name", "action"];
const ARG_KEYS = ["arguments", "parameters", "args", "params", "tool_input", "input"];

/**
 * Try to read `content` as a tool call. Returns null unless it parses and
 * names one of `knownTools`.
 */
export function salvageToolCall(content: string, knownTools: readonly string[]): ToolCall | null {
  if (!content.trim()) return null;

  // A model emitting several calls writes `[{...},{...}]`. Taking the first is
  // not lossy here: the agent loop runs it, feeds the result back, and the
  // model gets another turn to issue the rest. `firstJsonObject` reaching into
  // an array is therefore the behaviour we want, stated rather than incidental.
  const candidate = firstJsonObject(unfence(content));
  if (!candidate) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  let name: string | undefined;
  for (const key of NAME_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && knownTools.includes(v)) {
      name = v;
      break;
    }
    // Some models nest as { function: { name, arguments } }.
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = (v as Record<string, unknown>).name;
      if (typeof inner === "string" && knownTools.includes(inner)) {
        name = inner;
        const innerArgs = (v as Record<string, unknown>).arguments;
        return {
          id: `salvaged_${name}`,
          name,
          argumentsJson: JSON.stringify(innerArgs ?? {}),
        };
      }
    }
  }
  if (!name) return null;

  let args: unknown = {};
  for (const key of ARG_KEYS) {
    if (obj[key] !== undefined) {
      args = obj[key];
      break;
    }
  }
  // A model that put arguments at the top level alongside the tool name.
  if (
    (args === undefined || (typeof args === "object" && args !== null && Object.keys(args).length === 0)) &&
    Object.keys(obj).length > 1
  ) {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!NAME_KEYS.includes(k) && !ARG_KEYS.includes(k)) rest[k] = v;
    }
    if (Object.keys(rest).length > 0) args = rest;
  }

  // Arguments given as a JSON string rather than an object.
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }

  return { id: `salvaged_${name}`, name, argumentsJson: JSON.stringify(args ?? {}) };
}
