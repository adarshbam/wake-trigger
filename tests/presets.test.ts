import { describe, it, expect } from "vitest";
import { parseConfig } from "../src/config";
import { preset } from "../src/presets";

describe("preset", () => {
  it("handy preset toggles the handy group", () => {
    const c = parseConfig(preset("handy", "C:\\H\\handy.exe"));
    expect(c.triggers.map((t) => [t.phrase, t.group, t.sets])).toEqual([["computer listen", "handy", "on"], ["computer finish", "handy", "off"]]);
    expect(c.triggers[0].action).toEqual({ run: "C:\\H\\handy.exe", args: ["--toggle-post-process"] });
    expect(c.triggers[0].aliases).toContain("computer listening");
    expect(c.triggers.map((t) => t.requires)).toEqual(["handy.exe", "handy.exe"]);
    expect(c.triggers[0].launch).toEqual({ run: c.triggers[0].action && (c.triggers[0].action as { run: string }).run, args: ["--start-hidden"] });
    expect(c.triggers[1].launch).toBeUndefined();
  });

  it("handy preset uses a placeholder path when none is given", () => {
    const c = parseConfig(preset("handy"));
    expect(c.triggers[0].action).toEqual({ run: "C:\\path\\to\\handy.exe", args: ["--toggle-post-process"] });
  });

  it("default preset is valid and runs notepad", () => {
    const c = parseConfig(preset("default"));
    expect(c.triggers.map((t) => [t.phrase, t.group, t.sets])).toEqual([["computer listen", undefined, undefined], ["computer finish", undefined, undefined]]);
    expect(c.triggers[0].action).toEqual({ run: "notepad.exe" });
  });

  it("both presets set every top-level default explicitly", () => {
    for (const p of [preset("default"), preset("handy")]) {
      expect(p).toMatchObject({ microphone: "default", model: "moonshine-base-en", tolerance: 2, maxPhraseSeconds: 3, cooldownSeconds: 1.5, maxOnSeconds: 300, forceRepeatSeconds: 10, launchWaitSeconds: 5 });
    }
  });
});
