import { describe, it, expect } from "vitest";
import { normalize, editDistance } from "../src/normalize";

describe("normalize", () => {
  it("lower-cases and strips punctuation", () => {
    expect(normalize("Computer, Listen!")).toBe("computer listen");
  });
  it("collapses and trims spaces", () => {
    expect(normalize("  Stop   it. ")).toBe("stop it");
  });
  it("drops digits", () => {
    expect(normalize("1, 2")).toBe("");
  });
});

describe("editDistance", () => {
  it("counts substitutions", () => {
    expect(editDistance("computer stop", "computer stone")).toBe(2);
  });
  it("counts insertions from empty", () => {
    expect(editDistance("", "abc")).toBe(3);
  });
});
