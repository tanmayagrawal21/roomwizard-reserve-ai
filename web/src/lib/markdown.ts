/**
 * A deliberately tiny markdown subset for assistant replies.
 *
 * The model is asked for plain prose with at most bold and bullets, but small
 * models drift — observed live: `**BSRL-307 on 2026-10-13 from 15:00 to
 * 16:30**`, which rendered as literal asterisks. So the prompt sets the
 * intent and this makes the output look right either way.
 *
 * Hand-rolled rather than pulling in a markdown library because the needed
 * surface is bold, italic, inline code and bullets, and because the output is
 * returned as structured tokens for React to render — never as HTML. There is
 * no `innerHTML` anywhere in this path, so a model emitting `<script>` or a
 * javascript: link is inert text, not a vector.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string };

export type Block =
  | { kind: "paragraph"; spans: Inline[] }
  | { kind: "list"; items: Inline[][] };

/** `**a**`, `*a*`/`_a_`, and `` `a` `` — innermost-first, non-greedy. */
const INLINE = /(\*\*([^*]+)\*\*|\*([^*\n]+)\*|_([^_\n]+)_|`([^`\n]+)`)/;

/**
 * Drop a trailing marker that has no closing partner yet.
 *
 * While streaming, `**BSRL-258` arrives before its closing `**`, so the
 * asterisks flash as literal text for a moment and then vanish. Hiding the
 * dangling marker until it completes removes that flicker — only while
 * streaming, because in finished text an unmatched marker is genuinely what
 * the model wrote and should be shown.
 */
export function trimDanglingMarker(text: string): string {
  // An odd number of `**` runs means the last one is still open.
  const boldRuns = text.match(/\*\*/g)?.length ?? 0;
  let out = text;
  if (boldRuns % 2 === 1) out = out.slice(0, out.lastIndexOf("**"));
  // Same for a lone backtick.
  if ((out.match(/`/g)?.length ?? 0) % 2 === 1) out = out.slice(0, out.lastIndexOf("`"));
  return out;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;

  while (rest.length > 0) {
    const m = INLINE.exec(rest);
    if (!m || m.index === undefined) {
      out.push({ kind: "text", text: rest });
      break;
    }
    if (m.index > 0) out.push({ kind: "text", text: rest.slice(0, m.index) });

    if (m[2] !== undefined) out.push({ kind: "bold", text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: "italic", text: m[3] });
    else if (m[4] !== undefined) out.push({ kind: "italic", text: m[4] });
    else if (m[5] !== undefined) out.push({ kind: "code", text: m[5] });

    rest = rest.slice(m.index + m[1]!.length);
  }

  // Collapse adjacent plain runs so React renders fewer nodes.
  return out.filter((s) => s.kind !== "text" || s.text !== "");
}

/**
 * Split into paragraphs and bullet lists. Markdown headings are downgraded to
 * plain paragraphs rather than rendered — the prompt forbids them, and a giant
 * `<h1>` inside a chat bubble would look broken if one appears anyway.
 */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", spans: parseInline(paragraph.join(" ").trim()) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length > 0) {
      blocks.push({ kind: "list", items: list.map((i) => parseInline(i)) });
      list = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);

    if (line === "") {
      flushParagraph();
      flushList();
      continue;
    }
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]!);
      continue;
    }
    flushList();
    // Strip a heading marker and keep the words.
    paragraph.push(line.replace(/^#{1,6}\s*/, ""));
  }
  flushParagraph();
  flushList();

  return blocks;
}
