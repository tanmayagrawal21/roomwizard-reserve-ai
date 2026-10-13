/**
 * Renders the assistant's small markdown subset as React elements.
 *
 * Returns elements, never HTML — there is no `dangerouslySetInnerHTML` in this
 * path, so anything the model emits that looks like markup is shown as text.
 * See `lib/markdown.ts` for why the subset is deliberately tiny.
 */

import { parseBlocks, trimDanglingMarker, type Inline } from "../lib/markdown";

function Spans({ spans }: { spans: Inline[] }) {
  return (
    <>
      {spans.map((s, i) => {
        if (s.kind === "bold") return <strong key={i} className="font-semibold">{s.text}</strong>;
        if (s.kind === "italic") return <em key={i}>{s.text}</em>;
        if (s.kind === "code")
          return (
            <code
              key={i}
              className="rounded bg-black/10 px-1 py-px font-mono text-[0.9em] dark:bg-white/15"
            >
              {s.text}
            </code>
          );
        return <span key={i}>{s.text}</span>;
      })}
    </>
  );
}

export function FormattedText({
  text,
  streaming = false,
}: {
  text: string;
  /** Hides a marker whose closing partner has not arrived yet. */
  streaming?: boolean;
}) {
  const blocks = parseBlocks(streaming ? trimDanglingMarker(text) : text);
  if (blocks.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {blocks.map((b, i) =>
        b.kind === "list" ? (
          <ul key={i} className="list-disc space-y-0.5 pl-4">
            {b.items.map((item, j) => (
              <li key={j}>
                <Spans spans={item} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            <Spans spans={b.spans} />
          </p>
        ),
      )}
    </div>
  );
}
