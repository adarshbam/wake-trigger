import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { formatLaunching } from "../src/format";
import { ProcessWatch } from "../src/processes";

const t = (extra = {}) => ({ phrase: "a b", action: { run: "x" }, ...extra });

describe("launch in config", () => {
  it("keeps launch and defaults launchWaitSeconds to 5", () => {
    const c = parseConfig({ triggers: [t({ requires: "handy.exe", launch: { run: "handy.exe", args: ["--start-hidden"] } })] });
    expect(c.triggers[0].launch).toEqual({ run: "handy.exe", args: ["--start-hidden"] });
    expect(c.launchWaitSeconds).toBe(5);
    expect(parseConfig({ launchWaitSeconds: 0, triggers: [t()] }).launchWaitSeconds).toBe(0);
  });

  it("rejects launch without requires, with keys, or with an unknown field", () => {
    expect(() => parseConfig({ triggers: [t({ launch: { run: "handy.exe" } })] })).toThrow(/triggers\[0\]\.requires is required/);
    expect(() => parseConfig({ triggers: [t({ requires: "h.exe", launch: { keys: "ctrl+a" } })] })).toThrow(/triggers\[0\]\.launch must have "run"/);
    expect(() => parseConfig({ triggers: [t({ requires: "h.exe", launch: { run: "h.exe", shell: true } })] })).toThrow(/unknown field "triggers\[0\]\.launch\.shell"/);
    expect(() => parseConfig({ launchWaitSeconds: -1, triggers: [t()] })).toThrow(/launchWaitSeconds/);
  });
});

describe("formatLaunching", () => {
  it("names the program and the phrase", () => {
    const trigger = { phrase: "computer listen", aliases: [], requires: "handy.exe", action: { run: "x" } };
    expect(formatLaunching(new Date(2026, 0, 1, 3, 4, 5), trigger)).toBe('[03:04:05] starting handy.exe for "computer listen"');
  });
});

describe("ProcessWatch.waitFor", () => {
  it("resolves true once the process appears", async () => {
    let calls = 0;
    const watch = new ProcessWatch(async () => (++calls >= 3 ? ["handy.exe"] : []));
    expect(await watch.waitFor("Handy.exe", 2000, 5)).toBe(true);
    expect(calls).toBe(3);
  });

  it("resolves false when the time is up", async () => {
    const watch = new ProcessWatch(async () => []);
    expect(await watch.waitFor("handy.exe", 30, 5)).toBe(false);
  });

  it("resolves true when the process list cannot be read", async () => {
    const watch = new ProcessWatch(async () => { throw new Error("no tasklist"); });
    expect(await watch.waitFor("handy.exe", 30, 5)).toBe(true);
  });
});
