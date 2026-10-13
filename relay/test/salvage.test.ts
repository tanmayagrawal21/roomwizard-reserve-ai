import { describe, expect, it } from "vitest";
import { salvageToolCall } from "../src/salvage.ts";

const TOOLS = ["list_rooms", "find_slots", "check_room", "show_calendar", "propose_booking"];
const salvage = (s: string) => salvageToolCall(s, TOOLS);

describe("salvageToolCall: the shape qwen3:4b actually produced", () => {
  it("recovers the exact payload observed live", () => {
    // Copied verbatim from a real reply where tool_calls came back empty.
    const observed =
      '{"tool": "find_slots", "arguments": {"date": "2026-10-13", "days": 7, "duration_minutes": 90, "earliest_hour": 7, "latest_hour": 19, "min_capacity": 6, "needs": "camera"}}';
    const call = salvage(observed);
    expect(call?.name).toBe("find_slots");
    expect(JSON.parse(call!.argumentsJson)).toEqual({
      date: "2026-10-13",
      days: 7,
      duration_minutes: 90,
      earliest_hour: 7,
      latest_hour: 19,
      min_capacity: 6,
      needs: "camera",
    });
  });
});

describe("salvageToolCall: key-name variants", () => {
  it.each([
    ['{"tool":"list_rooms","arguments":{}}', "tool/arguments"],
    ['{"name":"list_rooms","arguments":{}}', "name/arguments"],
    ['{"tool_name":"list_rooms","parameters":{}}', "tool_name/parameters"],
    ['{"action":"list_rooms","args":{}}', "action/args"],
    ['{"function_name":"list_rooms","input":{}}', "function_name/input"],
  ])("handles %s (%s)", (payload) => {
    expect(salvage(payload)?.name).toBe("list_rooms");
  });

  it("handles the nested { function: { name, arguments } } form", () => {
    const call = salvage('{"function":{"name":"check_room","arguments":{"room_id":"bsrl-258","date":"2026-10-14"}}}');
    expect(call?.name).toBe("check_room");
    expect(JSON.parse(call!.argumentsJson).room_id).toBe("bsrl-258");
  });

  it("handles arguments given as a JSON string", () => {
    const call = salvage('{"tool":"find_slots","arguments":"{\\"duration_minutes\\":60}"}');
    expect(JSON.parse(call!.argumentsJson)).toEqual({ duration_minutes: 60 });
  });

  it("handles arguments spread at the top level next to the name", () => {
    const call = salvage('{"tool":"find_slots","duration_minutes":45,"days":3}');
    expect(JSON.parse(call!.argumentsJson)).toEqual({ duration_minutes: 45, days: 3 });
  });
});

describe("salvageToolCall: wrapping and surrounding prose", () => {
  it("unwraps a ```json fence", () => {
    expect(salvage('```json\n{"tool":"list_rooms","arguments":{}}\n```')?.name).toBe("list_rooms");
  });

  it("unwraps a bare ``` fence", () => {
    expect(salvage('```\n{"tool":"list_rooms","arguments":{}}\n```')?.name).toBe("list_rooms");
  });

  it("finds a call embedded after a sentence", () => {
    expect(
      salvage('Sure, let me check that. {"tool":"list_rooms","arguments":{}}')?.name,
    ).toBe("list_rooms");
  });

  it("handles braces inside string values without stopping early", () => {
    const call = salvage('{"tool":"propose_booking","arguments":{"purpose":"a {weird} name"}}');
    expect(JSON.parse(call!.argumentsJson).purpose).toBe("a {weird} name");
  });
});

describe("salvageToolCall: refuses to over-trigger", () => {
  it("ignores ordinary prose", () => {
    expect(salvage("BSRL-258 is free from 2pm to 4pm tomorrow.")).toBeNull();
  });

  it("ignores an unknown tool name", () => {
    expect(salvage('{"tool":"delete_everything","arguments":{}}')).toBeNull();
  });

  it("ignores JSON that is not a tool call", () => {
    expect(salvage('{"room":"bsrl-258","free":true}')).toBeNull();
  });

  it("ignores malformed JSON", () => {
    expect(salvage('{"tool":"find_slots", "arguments":')).toBeNull();
  });

  it("ignores an empty or whitespace reply", () => {
    expect(salvage("")).toBeNull();
    expect(salvage("   \n  ")).toBeNull();
  });

  it("takes the first call out of an array rather than giving up", () => {
    // A model emitting several calls at once writes `[{...},{...}]`. Running
    // the first is not lossy: the loop feeds its result back and the model
    // gets another turn for the rest.
    const call = salvage('[{"tool":"list_rooms","arguments":{}},{"tool":"find_slots","arguments":{}}]');
    expect(call?.name).toBe("list_rooms");
  });

  it("ignores a tool name that only appears in prose", () => {
    expect(salvage("I could use find_slots for that, shall I?")).toBeNull();
  });
});
