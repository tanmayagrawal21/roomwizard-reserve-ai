/**
 * Chat, with the picker's current selection as live context.
 *
 * The model cannot book. It calls `propose_booking`, which comes back as a
 * card here, and the card is what carries the password field and the confirm
 * button — the human's click is the only thing that calls `POST /api/book`
 * (PLAN.md section 5). That asymmetry is the point: a 4B model should not be
 * able to claim a shared room on its own reading of an ambiguous sentence.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  chatHealth,
  createBooking,
  ownerKey,
  RelayError,
  streamChat,
  type AgentProposal,
  type ChatContext,
  type Room,
  type UiDirective,
} from "../api";
import { useQuery } from "@tanstack/react-query";
import { addMyBooking } from "../lib/myBookings";
import { getProfile, saveProfile } from "../lib/profile";
import { FormattedText } from "./FormattedText";
import { generatePassword, PasswordField } from "./PasswordField";

interface Props {
  context: ChatContext;
  rooms: Room[];
  /** Lets the calendar reflect whatever the model just looked at. */
  onDirective: (d: UiDirective | null) => void;
  /** Collapses the panel. Not a "close" — the conversation is kept. */
  onCollapse: () => void;
  onBooked: () => void;
}

interface Bubble {
  role: "user" | "assistant";
  content: string;
  proposals?: AgentProposal[];
  toolsUsed?: string[];
  /** Still receiving tokens. */
  streaming?: boolean;
  /** Tool currently running, shown while there is nothing else to show. */
  activeTool?: string;
}

/** Plain-English status for the tool currently running. */
const TOOL_LABELS: Record<string, string> = {
  list_rooms: "looking up the rooms…",
  find_slots: "searching for openings…",
  check_room: "checking that room's schedule…",
  show_calendar: "moving the calendar…",
  propose_booking: "checking that slot is free…",
};

/** The conversation id is also the booking-ownership key; see api.ownerKey. */
const conversationId = ownerKey;

export function ChatPanel({ context, rooms, onDirective, onCollapse, onBooked }: Props) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Grow the textarea to fit what has been typed, up to the CSS max height.
   *
   * A textarea will not size itself, so this measures `scrollHeight` after
   * collapsing to `auto` — resetting first is what makes it shrink again as
   * text is deleted or after a send clears it. Capping is left to the
   * `max-h-40` class rather than duplicated here, so the limit lives in one
   * place; beyond it the element scrolls internally.
   */
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const health = useQuery({
    queryKey: ["chatHealth"],
    queryFn: ({ signal }) => chatHealth(signal),
    retry: false,
    staleTime: 60_000,
  });

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
    // `input` is a dependency because the growing textarea shortens the
    // transcript area; without this the last message drifts out of view as
    // you type a long message.
  }, [bubbles, busy, input]);

  async function submit() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);

    // The assistant bubble is created empty and filled by the stream, so the
    // first token appears immediately instead of after the whole reply.
    setBubbles((b) => [
      ...b,
      { role: "user", content: text },
      { role: "assistant", content: "", streaming: true },
    ]);

    /** Mutate just the in-flight assistant bubble, which is always last. */
    const patchLast = (fn: (b: Bubble) => Bubble) =>
      setBubbles((bs) => bs.map((b, i) => (i === bs.length - 1 ? fn(b) : b)));

    try {
      await streamChat(conversationId(), text, context, (ev) => {
        switch (ev.type) {
          case "token":
            patchLast((b) => ({ ...b, content: b.content + ev.text, activeTool: undefined }));
            break;
          case "discard":
            // What streamed turned out to be a tool call, not an answer.
            patchLast((b) => ({ ...b, content: "" }));
            break;
          case "tool":
            patchLast((b) => ({
              ...b,
              activeTool: ev.name,
              toolsUsed: [...(b.toolsUsed ?? []), ev.name],
            }));
            break;
          case "error":
            patchLast((b) => ({ ...b, content: ev.message, streaming: false }));
            break;
          case "done":
            onDirective(ev.turn.uiDirective);
            patchLast((b) => ({
              ...b,
              // Prefer the streamed text; fall back to the final reply if the
              // stream produced nothing visible (an all-tool-rounds turn).
              content: b.content || ev.turn.reply,
              proposals: ev.turn.proposals,
              toolsUsed: ev.turn.toolsUsed,
              streaming: false,
              activeTool: undefined,
            }));
            break;
        }
      });
    } catch (err) {
      patchLast((b) => ({
        ...b,
        content:
          err instanceof RelayError ? err.message : "Something went wrong talking to the model.",
        streaming: false,
        activeTool: undefined,
      }));
    } finally {
      setBusy(false);
    }
  }

  const contextLabel = [
    context.roomId,
    context.selectedDate,
    context.startTime && context.endTime ? `${context.startTime}-${context.endTime}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Ask</h2>
          {contextLabel && (
            <p className="truncate text-[11px] text-slate-400 dark:text-slate-500">
              looking at {contextLabel}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Collapse the assistant"
          className="rounded px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
        >
          Hide
        </button>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {health.data && !health.data.ok && (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:text-amber-200 dark:ring-amber-900/60">
              <p className="font-medium">The model isn't reachable.</p>
              <p className="mt-1 text-[11px] text-amber-800/90 dark:text-amber-300/90">
                Start it with <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/50">ollama serve</code>{" "}
                and <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/50">ollama pull {health.data.model}</code>,
                or point <code>RW_LLM_BASE_URL</code> somewhere else.
              </p>
            </div>
          )}

          {/* Where the model runs is a reasonable thing to wonder about, so
              state it. Worded to be accurate rather than merely reassuring:
              history *is* kept, locally, which is what makes the thread
              resume after a reload. Set RW_CHAT_DB_PATH=:memory: to stop
              that. */}
          <div className="rounded-md bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500 ring-1 ring-slate-200 dark:bg-slate-800/50 dark:text-slate-400 dark:ring-slate-700">
            Answered by{" "}
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {health.data?.model ?? "a local model"}
            </span>{" "}
            running on the relay in this building
            {health.data?.accelerator === "cpu" && " (on CPU — expect slow replies)"}
            {health.data?.accelerator === "partial" &&
              ` (only ${health.data.offloadPercent}% on the GPU — expect slow replies)`}
            . Nothing you type is sent to any third-party service. Your conversation is
            stored on that same machine so you can pick it up again later.
          </div>

          {bubbles.length === 0 && (
            <div className="py-6 text-center text-xs text-slate-400 dark:text-slate-500">
              <p>Ask for a room in plain English.</p>
              <p className="mt-2 space-x-1">
                {[
                  "90 minutes tomorrow afternoon for 6 people",
                  "is BSRL-258 free Thursday?",
                  "what have I booked?",
                  "move my meeting to 3pm",
                ].map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => setInput(ex)}
                    className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                  >
                    {ex}
                  </button>
                ))}
              </p>
            </div>
          )}

          {bubbles.map((b, i) => (
            <div key={i}>
              <div
                className={
                  "max-w-[90%] rounded-lg px-3 py-2 text-sm " +
                  (b.role === "user"
                    ? "ml-auto whitespace-pre-wrap bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
                    : "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100")
                }
              >
                {b.role === "user" ? b.content : <FormattedText text={b.content} streaming={b.streaming ?? false} />}
                {b.streaming && b.content === "" && (
                  <span className="text-slate-400 dark:text-slate-500">…</span>
                )}
              </div>
              {b.role === "assistant" && b.activeTool && (
                <p className="mt-1 flex items-center gap-1.5 text-[11px] text-fuchsia-600 dark:text-fuchsia-400">
                  <span className="inline-block size-1.5 animate-pulse rounded-full bg-fuchsia-500" />
                  {TOOL_LABELS[b.activeTool] ?? b.activeTool}
                </p>
              )}
              {b.role === "assistant" && !b.activeTool && b.toolsUsed && b.toolsUsed.length > 0 && (
                <p className="mt-1 text-[10px] text-slate-400 dark:text-slate-600">
                  checked: {[...new Set(b.toolsUsed)].join(", ")}
                </p>
              )}
              {b.proposals?.map((p) => (
                <ProposalCard
                  key={`${p.roomId}:${p.start}`}
                  proposal={p}
                  rooms={rooms}
                  onBooked={onBooked}
                />
              ))}
            </div>
          ))}


      </div>

      <div className="border-t border-slate-100 px-4 py-3 dark:border-slate-800">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter adds a line, which is the convention
              // people already expect from every other chat box.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="an hour tomorrow with a camera"
            // `max-h-40` caps the growth so a long message cannot push the
            // conversation off screen; past that the textarea scrolls itself.
            // `text-base` on small screens because anything under 16px makes
            // iOS Safari zoom the whole page on focus.
            className="max-h-40 min-w-0 flex-1 resize-none overflow-y-auto rounded-md border border-slate-300 bg-white px-2.5 py-2 text-base leading-snug text-slate-800 outline-none focus:border-slate-500 sm:text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy || input.trim() === ""}
            className="shrink-0 rounded-md bg-slate-800 px-3 py-2 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A proposal the model made. Nothing has been booked: this card collects the
 * password and the confirming click, then goes through the normal booking API.
 */
function ProposalCard({
  proposal,
  rooms,
  onBooked,
}: {
  proposal: AgentProposal;
  rooms: Room[];
  onBooked: () => void;
}) {
  const profile = getProfile();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState(() => generatePassword());
  const [firstName, setFirstName] = useState(profile.firstName);
  const [lastName, setLastName] = useState(profile.lastName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const hhmm = (iso: string) => iso.slice(11, 16);
  const canSubmit =
    password.length >= 4 && (firstName.trim() !== "" || lastName.trim() !== "") && !submitting;

  async function confirm() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createBooking({
        roomId: proposal.roomId,
        // Naive local strings: the relay resolves them in the fleet's zone.
        start: proposal.start.slice(0, 19),
        end: proposal.end.slice(0, 19),
        purpose: proposal.purpose,
        hostFirstName: firstName.trim(),
        hostLastName: lastName.trim(),
        ...(profile.email ? { hostEmail: profile.email } : {}),
        password,
        ownerKey: ownerKey(),
      });
      saveProfile({ firstName: firstName.trim(), lastName: lastName.trim(), email: profile.email });
      addMyBooking({
        id: result.id,
        roomId: result.roomId,
        roomName: rooms.find((r) => r.id === result.roomId)?.name ?? proposal.roomName,
        start: result.start,
        end: result.end,
        purpose: result.purpose,
        password: result.password,
        createdAt: new Date().toISOString(),
      });
      setDone(true);
      onBooked();
    } catch (err) {
      setError(err instanceof RelayError ? err.message : "Couldn't book that.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:ring-emerald-900/60">
        Booked {proposal.roomName}, {proposal.start.slice(0, 10)} {hhmm(proposal.start)}&ndash;
        {hhmm(proposal.end)}. It's in My bookings.
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-slate-300 px-3 py-2.5 dark:border-slate-600">
      <p className="text-xs font-medium text-slate-800 dark:text-slate-100">
        {proposal.roomName} &middot; {proposal.start.slice(0, 10)} {hhmm(proposal.start)}&ndash;
        {hhmm(proposal.end)}
      </p>
      <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{proposal.purpose}</p>
      <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
        Not booked yet &mdash; confirm below.
      </p>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-2 rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
        >
          Confirm&hellip;
        </button>
      ) : (
        <>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="First name"
              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Last name"
              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
          </div>
          <PasswordField value={password} onChange={setPassword} />
          {error && (
            <p className="mt-2 rounded-md bg-rose-50 px-2 py-1 text-[11px] text-rose-700 ring-1 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900">
              {error}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={confirm}
              disabled={!canSubmit}
              className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
            >
              {submitting ? "Booking…" : "Book it"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Not now
            </button>
          </div>
        </>
      )}
    </div>
  );
}
