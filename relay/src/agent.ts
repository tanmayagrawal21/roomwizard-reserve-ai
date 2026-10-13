/**
 * The chat turn: system prompt, tool loop, persistence.
 *
 * Runs relay-side because the relay is the only component that can reach both
 * the appliances and the model (PLAN.md section 4).
 *
 * The loop is bounded and the model cannot write. `propose_booking` returns a
 * card; the human's click is what calls `POST /api/book`. That is the whole
 * safety model for letting a 4B model near a shared resource.
 */

import { LLM_MAX_TOOL_ROUNDS, LLM_MODEL } from "./config.ts";
import { appendMessage, loadHistory } from "./chatStore.ts";
import { chat, chatStream, LlmError, type ChatMessage } from "./llm.ts";
import { getFleet } from "./rooms.ts";
import { runTool, TOOL_DEFS, type UiDirective } from "./tools.ts";
import { salvageToolCall } from "./salvage.ts";
import { addDays, toIsoDate } from "./time.ts";

/** What the picker currently has selected, injected so "this room" resolves. */
export interface UiContext {
  selectedDate?: string;
  roomId?: string;
  startTime?: string;
  endTime?: string;
}

export interface AgentProposal {
  roomId: string;
  roomName: string;
  start: string;
  end: string;
  purpose: string;
}

export interface AgentTurn {
  reply: string;
  /** Rendered as a confirmation card. The relay has booked nothing. */
  proposals: AgentProposal[];
  /** Tool names called, in order. Shown as a provenance trail in the UI. */
  toolsUsed: string[];
  /**
   * How the front-end should update its view to show what the model looked
   * at. Null when the turn didn't touch anything view-worthy (a plain
   * question, say), so the UI leaves the user's own view alone.
   */
  uiDirective: UiDirective | null;
}

/**
 * Resolve every relative date the model might need, so it never does calendar
 * arithmetic — the single most reliable failure mode of a small model.
 */
async function buildSystemPrompt(ui: UiContext): Promise<string> {
  const fleet = await getFleet(new Date());
  const now = new Date();
  const today = toIsoDate(now);

  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayNames: string[] = [];
  for (let i = 0; i <= 7; i++) {
    const d = addDays(now, i);
    const iso = toIsoDate(d);
    const label = i === 0 ? "today" : i === 1 ? "tomorrow" : weekdays[new Date(iso + "T12:00:00Z").getUTCDay()]!;
    dayNames.push(`${label} = ${iso}`);
  }

  const lines = [
    `You help people book meeting rooms in the ${fleet.site} building. Be brief and concrete.`,
    ``,
    `Today is ${today}. Resolved dates (use these verbatim, never calculate a date yourself):`,
    dayNames.map((d) => `  ${d}`).join("\n"),
    ``,
    `Rooms are bookable ${fleet.dayStartHour}:00-${fleet.dayEndHour}:00 local time.`,
    `Room ids: ${fleet.rooms.map((r) => r.id).join(", ")}.`,
    ``,
    `Rules:`,
    `- Use find_slots for any "when/where could we meet" question. Do not reason about availability yourself.`,
    `- For "what have I booked", "cancel my ...", "move my ..." use list_my_bookings first to get ids,`,
    `  then cancel_my_booking or reschedule_my_booking. Confirm which booking they mean before cancelling.`,
    `- You cannot book anything. To book, call propose_booking; the user then confirms it themselves.`,
    `- Never say a booking is done, made, or confirmed. Say you have proposed it and ask them to confirm.`,
    `- If a purpose was not given, ask for one before proposing.`,
    `- If a tool returns an error, read it and either fix your arguments or tell the user plainly.`,
    `- Keep replies to a couple of sentences. Mention room, day, and time; skip the scoring details.`,
    ``,
    `Formatting:`,
    `- Write plain prose. No markdown headings, tables, or code blocks.`,
    `- You may use **bold** for a room name or time, and "- " bullets when listing options. Nothing else.`,
    `- Write times as "2:30 pm" and dates as "Thu 15 Oct".`,
  ];

  if (ui.roomId || ui.selectedDate) {
    const parts: string[] = [];
    if (ui.roomId) parts.push(`room ${ui.roomId}`);
    if (ui.selectedDate) parts.push(`date ${ui.selectedDate}`);
    if (ui.startTime && ui.endTime) parts.push(`time ${ui.startTime}-${ui.endTime}`);
    lines.push(
      ``,
      `The user is currently looking at ${parts.join(", ")}. If they say "this room", "that slot",`,
      `or "then" without naming one, they mean this. Prefer it over asking.`,
    );
  }

  return lines.join("\n");
}

export async function runTurn(args: {
  conversationId: string;
  message: string;
  ui?: UiContext;
}): Promise<AgentTurn> {
  const { conversationId, message } = args;
  const ui = args.ui ?? {};

  appendMessage({ conversationId, role: "user", content: message });

  const system = await buildSystemPrompt(ui);
  const proposals: AgentProposal[] = [];
  const toolsUsed: string[] = [];
  let uiDirective: UiDirective | null = null;

  /**
   * Later directives win on each field, but highlights accumulate — if the
   * model checked two rooms, the user should see both sets called out rather
   * than only whichever it looked at last.
   */
  const mergeDirective = (next: UiDirective) => {
    uiDirective = {
      ...(uiDirective ?? {}),
      ...next,
      ...(next.highlights || uiDirective?.highlights
        ? { highlights: [...(uiDirective?.highlights ?? []), ...(next.highlights ?? [])] }
        : {}),
      ...(next.filters || uiDirective?.filters
        ? { filters: { ...(uiDirective?.filters ?? {}), ...(next.filters ?? {}) } }
        : {}),
    };
  };

  for (let round = 0; round < LLM_MAX_TOOL_ROUNDS; round++) {
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...loadHistory(conversationId),
    ];

    let reply;
    try {
      reply = await chat({ messages, tools: TOOL_DEFS });
    } catch (err) {
      const detail = err instanceof LlmError ? err.message : String(err);
      const friendly =
        err instanceof LlmError && err.status === 0
          ? `I can't reach the ${LLM_MODEL} model right now. ${detail}`
          : `The model errored: ${detail}`;
      // Not persisted as an assistant turn: a transport failure is not part of
      // the conversation, and replaying it would poison later context.
      return { reply: friendly, proposals, toolsUsed, uiDirective };
    }

    // Small models sometimes write the tool call as prose instead of emitting
    // it structurally. Recover it rather than handing the user raw JSON.
    const toolCalls =
      reply.toolCalls.length > 0
        ? reply.toolCalls
        : (() => {
            const salvaged = salvageToolCall(
              reply.content,
              TOOL_DEFS.map((t) => t.name),
            );
            return salvaged ? [salvaged] : [];
          })();

    if (toolCalls.length === 0) {
      const content = reply.content || "(no reply)";
      appendMessage({ conversationId, role: "assistant", content });
      return { reply: content, proposals, toolsUsed, uiDirective };
    }

    appendMessage({
      conversationId,
      // When the call was salvaged out of the content, don't also persist that
      // content: replaying "here is a JSON tool call" as an assistant turn
      // teaches the model that prose tool calls are acceptable.
      content: reply.toolCalls.length > 0 ? reply.content : "",
      role: "assistant",
      toolCalls,
    });

    for (const call of toolCalls) {
      toolsUsed.push(call.name);
      const result = await runTool(call.name, call.argumentsJson, conversationId);
      if (result.proposal) proposals.push(result.proposal);
      if (result.uiDirective) mergeDirective(result.uiDirective);
      appendMessage({
        conversationId,
        role: "tool",
        content: result.content,
        toolCallId: call.id,
        toolName: call.name,
      });
    }
  }

  // Ran out of rounds. Say so rather than inventing a conclusion; any
  // proposal already produced is still valid and worth surfacing.
  const stalled =
    proposals.length > 0
      ? "I've put a suggestion below — confirm it if it looks right."
      : "I'm going in circles on that one. Could you narrow it down — a day, a length, or a room?";
  appendMessage({ conversationId, role: "assistant", content: stalled });
  return { reply: stalled, proposals, toolsUsed, uiDirective };
}


/** Events the streaming turn emits, mirrored verbatim over SSE. */
export type TurnEvent =
  | { type: "token"; text: string }
  /** Discard provisional tokens: that text was a tool call, not an answer. */
  | { type: "discard" }
  | { type: "tool"; name: string }
  | { type: "done"; turn: AgentTurn }
  | { type: "error"; message: string };

/**
 * Streaming version of `runTurn`.
 *
 * Tokens are emitted optimistically, which means a round that turns out to be
 * a tool call has already sent provisional text. That is the right trade:
 * models overwhelmingly emit *either* prose or a tool call, so the common case
 * streams cleanly, and the rare mixed case is corrected by a `discard` rather
 * than making every answer wait until its nature is known.
 */
export async function* runTurnStream(args: {
  conversationId: string;
  message: string;
  ui?: UiContext;
}): AsyncGenerator<TurnEvent> {
  const { conversationId, message } = args;
  const ui = args.ui ?? {};

  appendMessage({ conversationId, role: "user", content: message });

  const system = await buildSystemPrompt(ui);
  const proposals: AgentProposal[] = [];
  const toolsUsed: string[] = [];
  let uiDirective: UiDirective | null = null;

  const mergeDirective = (next: UiDirective) => {
    uiDirective = {
      ...(uiDirective ?? {}),
      ...next,
      ...(next.highlights || uiDirective?.highlights
        ? { highlights: [...(uiDirective?.highlights ?? []), ...(next.highlights ?? [])] }
        : {}),
      ...(next.filters || uiDirective?.filters
        ? { filters: { ...(uiDirective?.filters ?? {}), ...(next.filters ?? {}) } }
        : {}),
    };
  };

  for (let round = 0; round < LLM_MAX_TOOL_ROUNDS; round++) {
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...loadHistory(conversationId),
    ];

    let content = "";
    let streamedAnything = false;
    let toolCalls: Awaited<ReturnType<typeof chat>>["toolCalls"] = [];

    try {
      for await (const ev of chatStream({ messages, tools: TOOL_DEFS })) {
        if (ev.type === "token") {
          streamedAnything = true;
          yield { type: "token", text: ev.text };
        } else if (ev.type === "end") {
          content = ev.content;
          toolCalls = ev.toolCalls;
        }
      }
    } catch (err) {
      const detail = err instanceof LlmError ? err.message : String(err);
      const friendly =
        err instanceof LlmError && err.status === 0
          ? `I can't reach the ${LLM_MODEL} model right now. ${detail}`
          : `The model errored: ${detail}`;
      if (streamedAnything) yield { type: "discard" };
      yield { type: "error", message: friendly };
      yield { type: "done", turn: { reply: friendly, proposals, toolsUsed, uiDirective } };
      return;
    }

    const effectiveCalls =
      toolCalls.length > 0
        ? toolCalls
        : (() => {
            const salvaged = salvageToolCall(content, TOOL_DEFS.map((t) => t.name));
            return salvaged ? [salvaged] : [];
          })();

    if (effectiveCalls.length === 0) {
      const finalText = content || "(no reply)";
      appendMessage({ conversationId, role: "assistant", content: finalText });
      yield { type: "done", turn: { reply: finalText, proposals, toolsUsed, uiDirective } };
      return;
    }

    // What streamed was a tool call, not an answer. Take it back.
    if (streamedAnything) yield { type: "discard" };

    appendMessage({
      conversationId,
      role: "assistant",
      content: toolCalls.length > 0 ? content : "",
      toolCalls: effectiveCalls,
    });

    for (const call of effectiveCalls) {
      toolsUsed.push(call.name);
      yield { type: "tool", name: call.name };
      const result = await runTool(call.name, call.argumentsJson, conversationId);
      if (result.proposal) proposals.push(result.proposal);
      if (result.uiDirective) mergeDirective(result.uiDirective);
      appendMessage({
        conversationId,
        role: "tool",
        content: result.content,
        toolCallId: call.id,
        toolName: call.name,
      });
    }
  }

  const stalled =
    proposals.length > 0
      ? "I've put a suggestion below — confirm it if it looks right."
      : "I'm going in circles on that one. Could you narrow it down — a day, a length, or a room?";
  appendMessage({ conversationId, role: "assistant", content: stalled });
  yield { type: "token", text: stalled };
  yield { type: "done", turn: { reply: stalled, proposals, toolsUsed, uiDirective } };
}
