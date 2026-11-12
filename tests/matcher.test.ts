import { describe, it, expect } from "vitest";
import { nearest, isMatch } from "../src/matcher";

const c = [{ triggerIndex: 0, phrase: "computer listen" }, { triggerIndex: 1, phrase: "computer finish" }];

describe("nearest", () => {
  it("exact match is distance 0 and unambiguous", () => {
    expect(nearest("computer listen", c)).toMatchObject({ triggerIndex: 0, distance: 0, ambiguous: false });
  });
  it("prefix rule gives distance 1", () => {
    expect(nearest("computer listening", c)).toMatchObject({ triggerIndex: 0, distance: 1 });
  });
  it("prefix rule limited to 3 extra letters", () => {
    expect(nearest("computer listen to me now", c)!.distance).toBeGreaterThan(2);
  });
  it("unrelated text is far", () => {
    expect(nearest("start the division", c)!.distance).toBeGreaterThan(2);
  });
  it("empty text gives null", () => {
    expect(nearest("", c)).toBeNull();
  });
  it("empty candidates gives null", () => {
    expect(nearest("ab", [])).toBeNull();
  });
  it("same distance to two different triggers is ambiguous", () => {
    expect(nearest("ab", [{ triggerIndex: 0, phrase: "aa" }, { triggerIndex: 1, phrase: "bb" }])!.ambiguous).toBe(true);
  });
  it("same distance to phrase and alias of one trigger is not ambiguous", () => {
    expect(nearest("ab", [{ triggerIndex: 0, phrase: "aa" }, { triggerIndex: 0, phrase: "bb" }])!.ambiguous).toBe(false);
  });
});

describe("isMatch", () => {
  it("accepts distance at tolerance", () => {
    expect(isMatch({ triggerIndex: 0, phrase: "x", distance: 2, ambiguous: false }, 2)).toBe(true);
  });
  it("rejects distance above tolerance", () => {
    expect(isMatch({ triggerIndex: 0, phrase: "x", distance: 3, ambiguous: false }, 2)).toBe(false);
  });
  it("rejects ambiguous", () => {
    expect(isMatch({ triggerIndex: 0, phrase: "x", distance: 0, ambiguous: true }, 2)).toBe(false);
  });
  it("rejects null", () => {
    expect(isMatch(null, 2)).toBe(false);
  });
});
