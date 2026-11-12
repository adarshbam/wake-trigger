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

beforeEach(() => {
  ms = 0;
  queuedSegments = [];
  queuedTexts = [];
  clipLengths = [];
  events = [];
  fired = [];
  pipeline = new Pipeline(config, segmenter, transcriber, {
    now,
    onClip: (e) => events.push(e),
    onFire: (t) => fired.push(t),
  });
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

  it("reports too-long without transcribing", () => {
    say("computer listen", { start: 1000, length: 16000 * 3 + 1 });
    expect(events[0].outcome).toBe("too-long");
    expect(events[0].text).toBe("");
    expect(events[0].nearest).toBeNull();
    expect(events[0].trigger).toBeNull();
    expect(clipLengths).toEqual([]);
    expect(fired).toEqual([]);
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
});
