import { describe, expect, it } from "vitest";
import { stripReasoning } from "../src/llm.ts";

describe("stripReasoning", () => {
  it("removes a complete think block", () => {
    expect(stripReasoning("<think>let me see...</think>BSRL-258 is free at 2pm.")).toBe(
      "BSRL-258 is free at 2pm.",
    );
  });

  it("removes a multi-line think block", () => {
    const raw = "<think>\nchecking rooms\nand times\n</think>\nTry BSRL-100.";
    expect(stripReasoning(raw)).toBe("Try BSRL-100.");
  });

  it("removes several blocks", () => {
    expect(stripReasoning("<think>a</think>One.<think>b</think>Two.")).toBe("One.Two.");
  });

  it("drops an unclosed block rather than leaking the tail", () => {
    // A cut-off generation leaves the scratchpad open; showing it would put
    // half a thought in front of the user as if it were the answer.
    expect(stripReasoning("Here you go.<think>hmm, actually wait")).toBe("Here you go.");
  });

  it("leaves ordinary replies untouched", () => {
    expect(stripReasoning("BSRL-307 at 3pm works.")).toBe("BSRL-307 at 3pm works.");
  });

  it("trims surrounding whitespace", () => {
    expect(stripReasoning("  \n hello \n ")).toBe("hello");
  });

  it("returns empty string for a reply that was only reasoning", () => {
    expect(stripReasoning("<think>nothing to say</think>")).toBe("");
  });
});
