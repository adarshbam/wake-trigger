import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseConfig, candidatesOf, ConfigError, homeDir, configPath, loadConfig } from "../src/config";

const t = (phrase: string, extra = {}) => ({ phrase, action: { run: "x" }, ...extra });

describe("parseConfig", () => {
  it("applies defaults and normalises candidates", () => {
    const c = parseConfig({ triggers: [t("Computer, Listen!")] });
    expect(c).toMatchObject({ microphone: "default", model: "moonshine-base-en", tolerance: 2,
      maxPhraseSeconds: 3, cooldownSeconds: 1.5, maxOnSeconds: 300 });
    expect(c.triggers[0].aliases).toEqual([]);
    expect(candidatesOf(c)).toEqual([{ triggerIndex: 0, phrase: "computer listen" }]);
  });

  it("keeps original strings and lists phrase then aliases per trigger", () => {
    const c = parseConfig({ triggers: [t("Computer, Listen!", { aliases: ["Hey Computer"] }), t("Other Thing")] });
    expect(c.triggers[0].phrase).toBe("Computer, Listen!");
    expect(c.triggers[0].aliases).toEqual(["Hey Computer"]);
    expect(candidatesOf(c)).toEqual([
      { triggerIndex: 0, phrase: "computer listen" },
      { triggerIndex: 0, phrase: "hey computer" },
      { triggerIndex: 1, phrase: "other thing" },
    ]);
  });

  it("rejects bad triggers", () => {
    expect(() => parseConfig({ triggers: [] })).toThrow(/triggers/);
    expect(() => parseConfig({ triggers: [t("!!!")] })).toThrow(/triggers\[0\]\.phrase/);
    expect(() => parseConfig({ triggers: [t("a b", { aliases: ["ok one", "??"] })] })).toThrow(/triggers\[0\]\.aliases\[1\]/);
  });

  it("requires group and sets together", () => {
    expect(() => parseConfig({ triggers: [t("a b", { group: "g" })] })).toThrow(/triggers\[0\]\.sets/);
    expect(() => parseConfig({ triggers: [t("a b", { sets: "on" })] })).toThrow(/triggers\[0\]\.group/);
  });

  it("validates action shape", () => {
    expect(() => parseConfig({ triggers: [{ phrase: "a b", action: {} }] })).toThrow(/triggers\[0\]\.action/);
    expect(() => parseConfig({ triggers: [{ phrase: "a b", action: { run: "x", keys: "ctrl+a" } }] })).toThrow(/action/);
    expect(() => parseConfig({ triggers: [{ phrase: "a b", action: { run: "" } }] })).toThrow(/action\.run/);
    expect(() => parseConfig({ triggers: [{ phrase: "a b", action: { keys: "" } }] })).toThrow(/action\.keys/);
    expect(() => parseConfig({ triggers: [{ phrase: "a b", action: { run: "x", args: [1] } }] })).toThrow(/action\.args/);
    expect(parseConfig({ triggers: [{ phrase: "a b", action: { run: "x", args: ["y"] } }] }).triggers[0].action)
      .toEqual({ run: "x", args: ["y"] });
    expect(parseConfig({ triggers: [{ phrase: "a b", action: { keys: "ctrl+a" } }] }).triggers[0].action)
      .toEqual({ keys: "ctrl+a" });
  });

  it("validates top-level fields", () => {
    expect(() => parseConfig({ model: "whisper", triggers: [t("a b")] })).toThrow(/model/);
    expect(() => parseConfig({ tolerance: -1, triggers: [t("a b")] })).toThrow(/tolerance/);
    expect(() => parseConfig({ maxPhraseSeconds: 0, triggers: [t("a b")] })).toThrow(/maxPhraseSeconds/);
    expect(() => parseConfig({ maxOnSeconds: 0, triggers: [t("a b")] })).toThrow(/maxOnSeconds/);
  });

  it("rejects phrases of different triggers within tolerance", () => {
    expect(() => parseConfig({ triggers: [t("computer stop"), t("computer shop")] }))
      .toThrow(/computer stop.*computer shop|too similar/);
    expect(() => parseConfig("nope")).toThrow(ConfigError);
  });
});

describe("paths and loadConfig", () => {
  it("builds home paths", () => {
    expect(homeDir()).toBe(path.join(os.homedir(), ".wake-trigger"));
    expect(configPath()).toBe(path.join(homeDir(), "config.json"));
  });

  it("WAKE_TRIGGER_HOME overrides the home folder", () => {
    const old = process.env.WAKE_TRIGGER_HOME;
    try {
      process.env.WAKE_TRIGGER_HOME = path.join(os.tmpdir(), "wt-home");
      expect(homeDir()).toBe(path.join(os.tmpdir(), "wt-home"));
      process.env.WAKE_TRIGGER_HOME = "";
      expect(homeDir()).toBe(path.join(os.homedir(), ".wake-trigger"));
    } finally {
      if (old === undefined) delete process.env.WAKE_TRIGGER_HOME;
      else process.env.WAKE_TRIGGER_HOME = old;
    }
  });

  it("missing file tells user to run init", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-"));
    try {
      expect(() => loadConfig(path.join(dir, "nope.json"))).toThrow(/wake-trigger init/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("invalid JSON names the file; valid file loads", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-"));
    try {
      const bad = path.join(dir, "bad.json");
      fs.writeFileSync(bad, "{ not json");
      expect(() => loadConfig(bad)).toThrow(ConfigError);
      expect(() => loadConfig(bad)).toThrow(/bad\.json/);
      const good = path.join(dir, "good.json");
      fs.writeFileSync(good, JSON.stringify({ triggers: [t("a b")] }));
      expect(loadConfig(good).triggers).toHaveLength(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
