import { describe, it, expect } from "vitest";
import { formatClip, formatTime } from "../src/format";
import type { ClipEvent } from "../src/pipeline";

const base: ClipEvent = { text: "computer listen", seconds: 1.234, level: 0.0456, nearest: { phrase: "computer listen", distance: 0 }, outcome: "fired", trigger: null };

describe("formatClip", () => {
  it("formats a full line", () => {
    expect(formatClip(base)).toBe('1.2s  level 0.046  "computer listen"  nearest "computer listen" (0)  -> fired');
  });
  it("omits nearest when null", () => {
    expect(formatClip({ ...base, nearest: null, outcome: "too-long", text: "" })).toBe('1.2s  level 0.046  ""  -> too-long');
  });
  it("warns on low level", () => {
    expect(formatClip({ ...base, level: 0.005 })).toMatch(/ {2}\(input level is low; raise microphone volume\)$/);
    expect(formatClip({ ...base, level: 0.01 })).not.toMatch(/low/);
  });
});

describe("formatTime", () => {
  it("pads HH:MM:SS", () => {
    expect(formatTime(new Date(2026, 0, 1, 3, 4, 5))).toBe("03:04:05");
  });
});
