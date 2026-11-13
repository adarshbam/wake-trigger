import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import type { Trigger } from "../src/config";
import { Pipeline } from "../src/pipeline";
import type { ClipEvent } from "../src/pipeline";
import type { Segment, Segmenter, Transcriber } from "../src/recognizer";

const config = parseConfig({
  triggers: [
    { phrase: "computer listen", group: "handy", sets: "on", action: { run: "x" } },
    { phrase: "computer finish", group: "handy", sets: "off", action: { run: "x" } },
  ],
});

let ms = 0;
const now = () => ms;
let queuedSegments: Segment[];
let queuedTexts: string[];
let clipLengths: number[];
let events: ClipEvent[];
let fired: Trigger[];
let pipeline: Pipeline;
let runningNames: string[] | null;
let launched: Trigger[];

const segmenter: Segmenter = {
  accept() {
    const out = queuedSegments;
    queuedSegments = [];
    return out;
  },
};
const transcriber: Transcriber = {
  transcribe(samples) {
    clipLengths.push(samples.length);
    return queuedTexts.shift() ?? "";
  },
};

function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * 16000));
}

function say(text: string, segment: Segment = { start: 16000, length: 12800 }): void {
  queuedSegments = [segment];
  queuedTexts = [text];
  pipeline.feed(new Float32Array(0));
}

function make(c: typeof config): Pipeline {
  return new Pipeline(c, segmenter, transcriber, {
    now,
    onClip: (e) => events.push(e),
    onFire: (t) => fired.push(t),
    isRunning: (name) => runningNames === null || runningNames.includes(name),
    onLaunch: (t) => launched.push(t),
  });
}

beforeEach(() => {
  ms = 0;
  queuedSegments = [];
  queuedTexts = [];
  clipLengths = [];
  events = [];
  fired = [];
  runningNames = null;
  launched = [];
  pipeline = make(config);
  pipeline.feed(silence(3));
});

describe("Pipeline", () => {
  it("fires and pads the clip", () => {
    say("Computer, listen.");
    expect(fired).toEqual([config.triggers[0]]);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("fired");
    expect(events[0].trigger).toBe(config.triggers[0]);
    expect(events[0].seconds).toBeCloseTo(0.8);
    expect(clipLengths).toEqual([12800 + 2 * 4800]);
  });

  it("clamps padding at the start of the audio", () => {
    say("computer listen", { start: 1600, length: 8000 });
    expect(clipLengths).toEqual([1600 + 8000 + 4800]);
  });

  it("with matchAtEnd off, reports too-long without transcribing", () => {
    pipeline = make(parseConfig({ matchAtEnd: false, triggers: [{ phrase: "computer listen", action: { run: "x" } }] }));
    pipeline.feed(silence(3));
    say("computer listen", { start: 1000, length: 16000 * 3 + 1 });
    expect(events[0]).toMatchObject({ outcome: "too-long", text: "", nearest: null, trigger: null, atEnd: false });
    expect(clipLengths).toEqual([]);
    expect(fired).toEqual([]);
  });

  it("finds a phrase at the end of long speech, transcribing only the last maxPhraseSeconds", () => {
    pipeline.feed(silence(8)); // 11 s held in total
    say("computer listen");
    ms = 5000;
    say("so that is everything I wanted to say computer finish", { start: 16000, length: 16000 * 6 });
    expect(events[1]).toMatchObject({ outcome: "fired", atEnd: true, trigger: config.triggers[1] });
    expect(clipLengths[1]).toBe(16000 * 3 + 4800); // last 3 s plus the padding after
    expect(fired).toEqual([config.triggers[0], config.triggers[1]]);
  });

  it("long speech that does not end with a phrase stays too-long", () => {
    pipeline.feed(silence(8));
    say("computer finish is what I say when I am done talking", { start: 16000, length: 16000 * 6 });
    expect(events[0]).toMatchObject({ outcome: "too-long", atEnd: true, trigger: null });
    expect(events[0].nearest).not.toBeNull();
    expect(fired).toEqual([]);
  });

  it("matches an end phrase with small errors, and a three-word alias by its own length", () => {
    const c = parseConfig({ triggers: [
      { phrase: "computer finish", aliases: ["complete the finish"], action: { run: "x" } },
    ] });
    pipeline = make(c);
    pipeline.feed(silence(11));
    say("and then we are done computer finnish", { start: 16000, length: 16000 * 6 });
    ms = 5000;
    say("and then we are done complete the finish", { start: 16000, length: 16000 * 6 });
    expect(events.map((e) => e.outcome)).toEqual(["fired", "fired"]);
  });

  it("reports no-match for other speech", () => {
    say("start the division");
    expect(events[0].outcome).toBe("no-match");
    expect(events[0].trigger).toBeNull();
    expect(events[0].nearest!.distance).toBeGreaterThan(2);
    expect(fired).toEqual([]);
  });

  it("respects group state", () => {
    say("computer finish");
    expect(events[0].outcome).toBe("blocked-by-state");
    expect(events[0].trigger).toBe(config.triggers[1]);
    say("computer listen");
    expect(events[1].outcome).toBe("fired");
    ms += 2000;
    say("computer finish");
    expect(events[2].outcome).toBe("fired");
    expect(fired).toEqual([config.triggers[0], config.triggers[1]]);
  });

  it("applies the cooldown after a fire", () => {
    say("computer listen");
    ms = 1000;
    say("computer finish");
    expect(events[1].outcome).toBe("cooldown");
    expect(events[1].trigger).toBe(config.triggers[1]);
    ms = 1600;
    say("computer finish");
    expect(events[2].outcome).toBe("fired");
  });

  it("treats an empty transcription as no-match with no nearest", () => {
    say("");
    expect(events[0].outcome).toBe("no-match");
    expect(events[0].nearest).toBeNull();
  });

  it("computes the RMS level of the unpadded clip", () => {
    const p = new Pipeline(config, segmenter, transcriber, { now, onClip: (e) => events.push(e), onFire: () => {} });
    const loud = new Float32Array(32000).fill(0.5);
    queuedSegments = [{ start: 8000, length: 8000 }];
    queuedTexts = ["hello"];
    p.feed(loud);
    expect(events[0].level).toBeCloseTo(0.5, 5);
  });

  it("keeps indexes right after a long run", () => {
    // Ramp audio: the value of each sample is derived from its absolute index.
    const ramp = (i: number) => (i % 1000) / 1000;
    const received: Float32Array[] = [];
    const capture: Transcriber = { transcribe(samples) { received.push(samples); return "computer listen"; } };
    const p = new Pipeline(config, segmenter, capture, { now, onClip: (e) => events.push(e), onFire: () => {} });
    let index = 0;
    const feedRamp = (n: number) => {
      const chunk = new Float32Array(n);
      for (let i = 0; i < n; i++) chunk[i] = ramp(index + i);
      index += n;
      p.feed(chunk);
    };
    for (let i = 0; i < (60 * 16000) / 512; i++) feedRamp(512);
    const start = index - 20000;
    const length = 8000;
    queuedSegments = [{ start, length }];
    feedRamp(512);
    expect(events.at(-1)!.outcome).toBe("fired");
    expect(received).toHaveLength(1);
    const clip = received[0];
    expect(clip.length).toBe(length + 2 * 4800);
    expect(clip[0]).toBeCloseTo(ramp(start - 4800), 6);
    expect(clip[clip.length - 1]).toBeCloseTo(ramp(start + length + 4800 - 1), 6);
  });

  it("forces a state-blocked phrase when it is repeated within forceRepeatSeconds", () => {
    say("computer finish");
    expect(events[0]).toMatchObject({ outcome: "blocked-by-state", forced: false });
    ms = 9000;
    say("computer finish");
    expect(events[1]).toMatchObject({ outcome: "fired", forced: true });
    expect(fired).toEqual([config.triggers[1]]);
    // the force is used up: the next one is blocked again
    ms = 12000;
    say("computer finish");
    expect(events[2].outcome).toBe("blocked-by-state");
  });

  it("does not force when the repeat comes too late, or when a different phrase was blocked", () => {
    say("computer finish");
    ms = 10001;
    say("computer finish");
    expect(events[1].outcome).toBe("blocked-by-state"); // too late; this one restarts the window
    ms = 12000;
    say("computer listen");
    expect(events[2]).toMatchObject({ outcome: "fired", forced: false });
    ms = 14000;
    say("computer listen");
    expect(events[3].outcome).toBe("blocked-by-state"); // first block of this phrase
    expect(fired).toEqual([config.triggers[0]]);
  });

  it("a forced start keeps the group on, so the stop phrase then works", () => {
    say("computer listen");
    ms = 7000;
    say("computer listen");
    ms = 10000;
    say("computer listen");
    expect(events.map((e) => [e.outcome, e.forced])).toEqual([["fired", false], ["blocked-by-state", false], ["fired", true]]);
    ms = 13000;
    say("computer finish");
    expect(events[3]).toMatchObject({ outcome: "fired", forced: false });
  });

  it("repeats in the 6 seconds after a fire never force, however many there are", () => {
    say("computer listen");
    for (ms = 1600; ms < 6000; ms += 1000) say("computer listen");
    expect(events.slice(1).every((e) => e.outcome === "blocked-by-state" && !e.forced)).toBe(true);
    expect(fired).toEqual([config.triggers[0]]);
    // and they did not count toward a force: the first repeat after the settling time is only the first block
    ms = 6000;
    say("computer listen");
    expect(events.at(-1)).toMatchObject({ outcome: "blocked-by-state", forced: false });
    ms = 8000;
    say("computer listen");
    expect(events.at(-1)).toMatchObject({ outcome: "fired", forced: true });
  });

  it("gives a launched program longer to settle before a repeat can force", () => {
    const c = parseConfig({ launchWaitSeconds: 5, triggers: [
      { phrase: "computer listen", group: "handy", sets: "on", requires: "handy.exe", launch: { run: "handy.exe" }, action: { run: "x" } },
      { phrase: "computer finish", group: "handy", sets: "off", requires: "handy.exe", action: { run: "x" } },
    ] });
    pipeline = make(c);
    pipeline.feed(silence(3));
    runningNames = [];
    say("computer listen");
    expect(events[0].outcome).toBe("launching");
    runningNames = ["handy.exe"];
    for (ms = 2000; ms < 17000; ms += 2000) say("computer listen");
    expect(events.slice(1).every((e) => e.outcome === "blocked-by-state" && !e.forced)).toBe(true);
    expect(fired).toEqual([]);
    expect(launched).toHaveLength(1);
  });

  it("forceRepeatSeconds 0 disables forcing", () => {
    pipeline = make(parseConfig({ forceRepeatSeconds: 0, triggers: [
      { phrase: "computer listen", group: "handy", sets: "on", action: { run: "x" } },
      { phrase: "computer finish", group: "handy", sets: "off", action: { run: "x" } },
    ] }));
    pipeline.feed(silence(3));
    say("computer finish");
    ms = 2000;
    say("computer finish");
    expect(events.map((e) => e.outcome)).toEqual(["blocked-by-state", "blocked-by-state"]);
  });

  it("skips a trigger whose required process is not running, without changing state", () => {
    const c = parseConfig({ triggers: [
      { phrase: "computer listen", group: "handy", sets: "on", requires: "handy.exe", action: { run: "x" } },
      { phrase: "computer finish", group: "handy", sets: "off", requires: "handy.exe", action: { run: "x" } },
    ] });
    pipeline = make(c);
    pipeline.feed(silence(3));
    runningNames = [];
    say("computer listen");
    expect(events[0]).toMatchObject({ outcome: "not-running", trigger: c.triggers[0] });
    expect(fired).toEqual([]);
    runningNames = ["handy.exe"];
    ms = 2000;
    say("computer listen");
    expect(events[1].outcome).toBe("fired"); // state was not turned on by the skipped attempt
  });

  it("launches the required program instead of firing when the trigger has launch", () => {
    const c = parseConfig({ triggers: [
      { phrase: "computer listen", group: "handy", sets: "on", requires: "handy.exe", launch: { run: "handy.exe" }, action: { run: "x" } },
      { phrase: "computer finish", group: "handy", sets: "off", requires: "handy.exe", action: { run: "x" } },
    ] });
    pipeline = make(c);
    pipeline.feed(silence(3));
    runningNames = [];
    say("computer finish");
    expect(events[0].outcome).toBe("not-running"); // the stop trigger has no launch
    ms = 2000;
    say("computer listen");
    expect(events[1]).toMatchObject({ outcome: "launching", trigger: c.triggers[0] });
    expect(launched).toEqual([c.triggers[0]]);
    expect(fired).toEqual([]);
    // the group is on now, so the start phrase is blocked and the stop phrase works once the program is up
    ms = 4000;
    say("computer listen");
    expect(events[2].outcome).toBe("blocked-by-state");
    runningNames = ["handy.exe"];
    ms = 12000;
    say("computer finish");
    expect(events[3].outcome).toBe("fired");
    expect(fired).toEqual([c.triggers[1]]);
  });

  it("fires normally when the program with launch is already running", () => {
    const c = parseConfig({ triggers: [
      { phrase: "computer listen", requires: "handy.exe", launch: { run: "handy.exe" }, action: { run: "x" } },
    ] });
    pipeline = make(c);
    pipeline.feed(silence(3));
    runningNames = ["handy.exe"];
    say("computer listen");
    expect(events[0].outcome).toBe("fired");
    expect(launched).toEqual([]);
  });
});
