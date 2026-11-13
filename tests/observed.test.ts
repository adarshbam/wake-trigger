import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseConfig } from "../src/config";
import type { Trigger } from "../src/config";
import { LogWatch } from "../src/logwatch";
import { Pipeline } from "../src/pipeline";
import type { ClipEvent } from "../src/pipeline";
import type { Segment, Segmenter, Transcriber } from "../src/recognizer";
import { GroupState } from "../src/state";

const on: Trigger = { phrase: "a", aliases: [], group: "g", sets: "on", action: { run: "x" } };
const off: Trigger = { ...on, sets: "off" };

describe("GroupState, observed group", () => {
  let ms = 0;
  const make = () => { ms = 0; const s = new GroupState(300, () => ms); s.watch("g"); return s; };

  it("follows what the app reports", () => {
    const s = make();
    expect(s.isObserved("g")).toBe(true);
    expect(s.allows(on)).toBe(true);
    s.observe("g", true);
    expect(s.allows(on)).toBe(false);
    expect(s.allows(off)).toBe(true);
    s.observe("g", false);
    expect(s.allows(on)).toBe(true);
    expect(s.allows(off)).toBe(false);
  });

  it("trusts a command just sent until the confirm time, then falls back to the app's last report", () => {
    const s = make();
    s.apply(on, 3000);
    expect(s.allows(on)).toBe(false); // repeats are held back while the app reacts
    ms = 2999;
    expect(s.allows(on)).toBe(false);
    ms = 3000;
    expect(s.allows(on)).toBe(true);  // the app never confirmed: try again is allowed
    expect(s.allows(off)).toBe(false);
  });

  it("a report from the app ends the waiting at once", () => {
    const s = make();
    s.apply(on, 3000);
    s.observe("g", true);
    ms = 60_000_000; // no timeout for an observed group
    expect(s.allows(on)).toBe(false);
    expect(s.allows(off)).toBe(true);
  });

  it("reset turns the group off", () => {
    const s = make();
    s.observe("g", true);
    s.reset("g");
    expect(s.allows(on)).toBe(true);
  });

  it("observe on a group that is not watched does nothing", () => {
    const s = new GroupState(300, () => ms);
    s.observe("g", true);
    expect(s.allows(on)).toBe(true);
  });
});

describe("LogWatch", () => {
  let dir: string;
  let file: string;
  let lines: string[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-log-"));
    file = path.join(dir, "app.log");
    lines = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const watch = () => new LogWatch(file, (l) => lines.push(l), 10_000);

  it("hands over appended complete lines only", () => {
    fs.writeFileSync(file, "one\ntwo\npart");
    const w = watch();
    w.poll();
    expect(lines).toEqual(["one", "two"]);
    fs.appendFileSync(file, "ial\r\nthree\n");
    w.poll();
    expect(lines).toEqual(["one", "two", "partial", "three"]);
    w.poll();
    expect(lines).toHaveLength(4);
  });

  it("starts again from the top when the file is truncated", () => {
    fs.writeFileSync(file, "old one\nold two\n");
    const w = watch();
    w.poll();
    fs.writeFileSync(file, "new\n");
    w.poll();
    expect(lines).toEqual(["old one", "old two", "new"]);
  });

  it("waits for a file that does not exist yet", () => {
    const w = watch();
    w.poll();
    expect(lines).toEqual([]);
    fs.writeFileSync(file, "hello\n");
    w.poll();
    expect(lines).toEqual(["hello"]);
  });

  it("start reads only the tail and drops the cut first line", () => {
    fs.writeFileSync(file, "aaaaaaaaaa\nbbbbbbbbbb\ncccc\n");
    const w = watch();
    w.start(8); // lands inside the b line
    w.stop();
    expect(lines).toEqual(["cccc"]);
  });
});

describe("Pipeline with a watched group", () => {
  const config = parseConfig({
    groups: { handy: { watchFile: "unused.log", onPattern: "START", offPattern: "STOP" } },
    triggers: [
      { phrase: "computer listen", group: "handy", sets: "on", requires: "handy.exe", launch: { run: "handy.exe" }, action: { run: "x" } },
      { phrase: "computer finish", group: "handy", sets: "off", requires: "handy.exe", action: { run: "x" } },
    ],
  });
  let ms: number;
  let queuedSegments: Segment[];
  let queuedTexts: string[];
  let events: ClipEvent[];
  let fired: string[];
  let launched: string[];
  let running: boolean;
  let pipeline: Pipeline;
  const segmenter: Segmenter = { accept() { const out = queuedSegments; queuedSegments = []; return out; } };
  const transcriber: Transcriber = { transcribe() { return queuedTexts.shift() ?? ""; } };
  const say = (text: string) => {
    queuedSegments = [{ start: 16000, length: 12800 }];
    queuedTexts = [text];
    pipeline.feed(new Float32Array(0));
  };
  beforeEach(() => {
    ms = 0; queuedSegments = []; queuedTexts = []; events = []; fired = []; launched = []; running = true;
    pipeline = new Pipeline(config, segmenter, transcriber, {
      now: () => ms,
      onClip: (e) => events.push(e),
      onFire: (t) => fired.push(t.phrase),
      onLaunch: (t) => launched.push(t.phrase),
      isRunning: () => running,
    });
    pipeline.feed(new Float32Array(16000 * 3));
  });

  it("saying the start phrase many times starts once and never undoes it", () => {
    say("computer listen");
    pipeline.observe("handy", true); // Handy logged the start
    for (ms = 2000; ms <= 60000; ms += 2000) say("computer listen");
    expect(fired).toEqual(["computer listen"]);
    expect(events.slice(1).every((e) => e.outcome === "blocked-by-state" && !e.forced)).toBe(true);
  });

  it("saying the stop phrase many times stops once", () => {
    pipeline.observe("handy", true);
    say("computer finish");
    pipeline.observe("handy", false);
    for (ms = 2000; ms <= 30000; ms += 2000) say("computer finish");
    expect(fired).toEqual(["computer finish"]);
  });

  it("tries again when the app did not confirm within confirmSeconds", () => {
    say("computer listen");          // sent, but Handy never logs a start
    ms = 2000;
    say("computer listen");
    expect(events[1].outcome).toBe("blocked-by-state"); // still waiting for confirmation
    ms = 4000;
    say("computer listen");
    expect(events[2]).toMatchObject({ outcome: "fired", forced: false });
    expect(fired).toEqual(["computer listen", "computer listen"]);
  });

  it("follows a start made by keyboard, so the stop phrase works without having said the start phrase", () => {
    pipeline.observe("handy", true);
    say("computer finish");
    expect(events[0].outcome).toBe("fired");
  });

  it("follows a stop made by keyboard, so the start phrase works again at once", () => {
    say("computer listen");
    pipeline.observe("handy", true);
    pipeline.observe("handy", false); // stopped with the hotkey
    ms = 2000;
    say("computer listen");
    expect(fired).toEqual(["computer listen", "computer listen"]);
  });

  it("while the app is being started, repeats are held back for the whole start-up, then the log decides", () => {
    running = false;
    say("computer listen");
    expect(events[0].outcome).toBe("launching");
    running = true;
    for (ms = 2000; ms < 14000; ms += 2000) say("computer listen"); // launchWait 5 + allowance 6 + confirm 3 = 14 s
    expect(launched).toEqual(["computer listen"]);
    expect(fired).toEqual([]);
    pipeline.observe("handy", true); // Handy came up and logged the start
    ms = 20000;
    say("computer listen");
    expect(fired).toEqual([]);
  });

  it("repeats while the app is still missing during start-up do not start it twice", () => {
    running = false;
    say("computer listen");
    for (ms = 2000; ms < 11000; ms += 2000) say("computer listen"); // still not in the process list
    expect(launched).toEqual(["computer listen"]);
    ms = 15000; // start-up time is over and it never appeared: the next phrase tries again
    say("computer listen");
    expect(launched).toEqual(["computer listen", "computer listen"]);
  });

  it("a closed app is off even if its log last said on", () => {
    pipeline.observe("handy", true); // stale: Handy was killed while recording
    running = false;
    say("computer listen");
    expect(events[0].outcome).toBe("launching");
  });
});

describe("groups in config", () => {
  const triggers = [{ phrase: "a b", group: "g", sets: "on", action: { run: "x" } }];
  it("parses a watched group with a default confirmSeconds of 3", () => {
    const c = parseConfig({ groups: { g: { watchFile: "f.log", onPattern: "on", offPattern: "off" } }, triggers });
    expect(c.groups.g).toEqual({ watchFile: "f.log", onPattern: "on", offPattern: "off", confirmSeconds: 3 });
    expect(parseConfig({ triggers }).groups).toEqual({});
  });
  it("rejects a bad pattern, a missing field, an unknown field and an unused group", () => {
    const g = { watchFile: "f.log", onPattern: "on", offPattern: "off" };
    expect(() => parseConfig({ groups: { g: { ...g, onPattern: "(" } }, triggers })).toThrow(/groups\.g\.onPattern is not a valid regular expression/);
    expect(() => parseConfig({ groups: { g: { watchFile: "f.log", onPattern: "on" } }, triggers })).toThrow(/groups\.g\.offPattern/);
    expect(() => parseConfig({ groups: { g: { ...g, extra: 1 } }, triggers })).toThrow(/unknown field "groups\.g\.extra"/);
    expect(() => parseConfig({ groups: { other: g }, triggers })).toThrow(/no trigger uses the group "other"/);
    expect(() => parseConfig({ groups: { g: { ...g, confirmSeconds: 0 } }, triggers })).toThrow(/confirmSeconds/);
  });
});
