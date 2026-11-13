import { describe, it, expect } from "vitest";
import { formatClip, describeError, formatFired, formatIgnored, formatNotRunning, formatTime } from "../src/format";
import type { ClipEvent } from "../src/pipeline";

const base: ClipEvent = { text: "computer listen", seconds: 1.234, level: 0.0456, nearest: { phrase: "computer listen", distance: 0 }, outcome: "fired", trigger: null, forced: false, atEnd: false };

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

describe("formatIgnored", () => {
  it("names the phrase and the reason", () => {
    const trigger = { phrase: "computer listen", aliases: [], action: { run: "x" } };
    const d = new Date(2026, 0, 1, 3, 4, 5);
    expect(formatIgnored(d, trigger, "blocked-by-state")).toBe('[03:04:05] ignored "computer listen" (blocked-by-state)');
    expect(formatIgnored(d, trigger, "cooldown")).toBe('[03:04:05] ignored "computer listen" (cooldown)');
  });
});

describe("formatClip at end of speech", () => {
  it("marks a match found at the end, and leaves a clip without a trigger plain", () => {
    const trigger = { phrase: "computer listen", aliases: [], action: { run: "x" } };
    expect(formatClip({ ...base, seconds: 6.8, atEnd: true, trigger })).toContain("-> fired (at end of speech)");
    expect(formatClip({ ...base, seconds: 6.8, atEnd: true, outcome: "too-long" })).toMatch(/-> too-long$/);
    expect(formatClip({ ...base, atEnd: true, outcome: "no-match" })).toMatch(/-> no-match$/);
  });
});

describe("formatFired and formatNotRunning", () => {
  const d = new Date(2026, 0, 1, 3, 4, 5);
  const trigger = { phrase: "computer finish", aliases: [], requires: "handy.exe", action: { run: "x" } };
  it("marks a forced fire", () => {
    expect(formatFired(d, trigger, false)).toBe('[03:04:05] fired "computer finish"');
    expect(formatFired(d, trigger, true)).toBe('[03:04:05] fired "computer finish" (forced by repeat)');
  });
  it("names the missing process", () => {
    expect(formatNotRunning(d, trigger)).toBe('[03:04:05] skipped "computer finish" (handy.exe is not running)');
  });
});

describe("describeError", () => {
  it("appends the cause message when present", () => {
    const e = new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND github.com") });
    expect(describeError(e)).toBe("fetch failed: getaddrinfo ENOTFOUND github.com");
    expect(describeError(new Error("plain"))).toBe("plain");
    expect(describeError("text")).toBe("text");
  });
});
