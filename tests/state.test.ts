import { describe, it, expect } from "vitest";
import { GroupState } from "../src/state";
import type { Trigger } from "../src/config";

const on: Trigger = { phrase: "a", aliases: [], group: "g", sets: "on", action: { run: "x" } };
const off: Trigger = { ...on, sets: "off" };
const free: Trigger = { phrase: "b", aliases: [], action: { run: "x" } };

function make() {
  let ms = 0;
  const s = new GroupState(300, () => ms);
  return { s, setMs: (v: number) => { ms = v; } };
}

describe("GroupState", () => {
  it("allows a trigger with no group", () => {
    const { s } = make();
    expect(s.allows(free)).toBe(true);
  });

  it("ignores stop while idle, allows start", () => {
    const { s } = make();
    expect(s.allows(off)).toBe(false);
    expect(s.allows(on)).toBe(true);
  });

  it("after start: start blocked, stop allowed", () => {
    const { s } = make();
    s.apply(on);
    expect(s.allows(on)).toBe(false);
    expect(s.allows(off)).toBe(true);
  });

  it("after stop: start allowed again", () => {
    const { s } = make();
    s.apply(on);
    s.apply(off);
    expect(s.allows(on)).toBe(true);
  });

  it("times out back to off after maxOnSeconds", () => {
    const { s, setMs } = make();
    s.apply(on);
    setMs(300_001);
    expect(s.allows(on)).toBe(true);
    expect(s.allows(off)).toBe(false);
  });

  it("still on exactly at maxOnSeconds", () => {
    const { s, setMs } = make();
    s.apply(on);
    setMs(300_000);
    expect(s.allows(on)).toBe(false);
  });

  it("keeps groups independent", () => {
    const { s } = make();
    const other: Trigger = { ...on, group: "h" };
    s.apply(on);
    expect(s.allows(other)).toBe(true);
  });

  it("apply on a trigger with no group does nothing", () => {
    const { s } = make();
    s.apply(free);
    expect(s.allows(on)).toBe(true);
  });
});
