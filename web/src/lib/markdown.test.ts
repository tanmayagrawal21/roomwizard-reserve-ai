import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline, trimDanglingMarker } from "./markdown";

const text = (s: string) => ({ kind: "text", text: s });

describe("parseInline", () => {
  it("leaves plain text alone", () => {
    expect(parseInline("BSRL-258 at 2pm")).toEqual([text("BSRL-258 at 2pm")]);
  });

  it("parses the bold the model actually emitted", () => {
    // Observed live: this rendered as literal asterisks before.
    const spans = parseInline("The earliest is **BSRL-307 from 15:00 to 16:30** (8 seats).");
    expect(spans).toEqual([
      text("The earliest is "),
      { kind: "bold", text: "BSRL-307 from 15:00 to 16:30" },
      text(" (8 seats)."),
    ]);
  });

  it("parses italics in both spellings", () => {
    expect(parseInline("*a*")).toEqual([{ kind: "italic", text: "a" }]);
    expect(parseInline("_b_")).toEqual([{ kind: "italic", text: "b" }]);
  });

  it("parses inline code", () => {
    expect(parseInline("try `bsrl-203`")).toEqual([
      text("try "),
      { kind: "code", text: "bsrl-203" },
    ]);
  });

  it("handles several spans in one line", () => {
    expect(parseInline("**a** and **b**")).toEqual([
      { kind: "bold", text: "a" },
      text(" and "),
      { kind: "bold", text: "b" },
    ]);
  });

  it("prefers bold over italic for a double marker", () => {
    expect(parseInline("**x**")).toEqual([{ kind: "bold", text: "x" }]);
  });

  it("leaves an unmatched marker as text rather than eating the rest", () => {
    expect(parseInline("2 ** 3 is not bold")).toEqual([text("2 ** 3 is not bold")]);
  });

  it("does not treat a bare asterisk as a marker", () => {
    expect(parseInline("a * b")).toEqual([text("a * b")]);
  });

  it("returns nothing for an empty string", () => {
    expect(parseInline("")).toEqual([]);
  });
});

describe("parseBlocks", () => {
  it("makes one paragraph from one line", () => {
    expect(parseBlocks("BSRL-100 is free all day.")).toEqual([
      { kind: "paragraph", spans: [text("BSRL-100 is free all day.")] },
    ]);
  });

  it("splits paragraphs on a blank line", () => {
    const blocks = parseBlocks("First.\n\nSecond.");
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.kind === "paragraph")).toBe(true);
  });

  it("joins wrapped lines into one paragraph", () => {
    expect(parseBlocks("a\nb")).toEqual([
      { kind: "paragraph", spans: [text("a b")] },
    ]);
  });

  it("parses a dash bullet list", () => {
    const blocks = parseBlocks("Options:\n- BSRL-100 at 9am\n- BSRL-203 at 2pm");
    expect(blocks[0]!.kind).toBe("paragraph");
    expect(blocks[1]).toEqual({
      kind: "list",
      items: [[text("BSRL-100 at 9am")], [text("BSRL-203 at 2pm")]],
    });
  });

  it("parses numbered and bulleted lists alike", () => {
    expect(parseBlocks("1. one\n2) two")).toEqual([
      { kind: "list", items: [[text("one")], [text("two")]] },
    ]);
    expect(parseBlocks("* a\n• b")).toEqual([
      { kind: "list", items: [[text("a")], [text("b")]] },
    ]);
  });

  it("keeps inline formatting inside list items", () => {
    expect(parseBlocks("- **BSRL-258** at 2pm")).toEqual([
      { kind: "list", items: [[{ kind: "bold", text: "BSRL-258" }, text(" at 2pm")]] },
    ]);
  });

  it("downgrades a heading to a paragraph instead of rendering it huge", () => {
    expect(parseBlocks("## Available rooms")).toEqual([
      { kind: "paragraph", spans: [text("Available rooms")] },
    ]);
  });

  it("returns nothing for empty or whitespace-only input", () => {
    expect(parseBlocks("")).toEqual([]);
    expect(parseBlocks("\n\n  \n")).toEqual([]);
  });

  it("treats raw HTML as text, never as markup", () => {
    // The renderer returns tokens for React, so this can only ever be shown
    // literally — but assert it so nobody "optimises" to innerHTML later.
    const blocks = parseBlocks("<script>alert(1)</script>");
    expect(blocks).toEqual([
      { kind: "paragraph", spans: [text("<script>alert(1)</script>")] },
    ]);
  });
});

describe("trimDanglingMarker", () => {
  it("hides a bold marker still waiting for its partner", () => {
    // Captured mid-stream: the closing ** has not arrived yet.
    expect(trimDanglingMarker("The rooms are **b")).toBe("The rooms are ");
  });

  it("leaves balanced bold alone", () => {
    expect(trimDanglingMarker("**BSRL-258** is free")).toBe("**BSRL-258** is free");
  });

  it("hides a dangling backtick", () => {
    expect(trimDanglingMarker("try `bsrl-2")).toBe("try ");
  });

  it("leaves text with no markers alone", () => {
    expect(trimDanglingMarker("BSRL-100 at 2pm")).toBe("BSRL-100 at 2pm");
  });

  it("handles several complete pairs plus one open", () => {
    expect(trimDanglingMarker("**a** and **b** and **c")).toBe("**a** and **b** and ");
  });
});
