import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { parseConfig } from "../src/config";
import { modelFiles, modelsPresent } from "../src/models";
import { Pipeline } from "../src/pipeline";
import type { ClipEvent } from "../src/pipeline";
import { createSegmenter, createTranscriber } from "../src/recognizer";

const fixture = path.join(__dirname, "fixtures", "listen.f32");
const CHUNK = 512;

describe.skipIf(!modelsPresent("moonshine-base-en") || !existsSync(fixture))("pipeline (real audio)", () => {
  it("fires on spoken 'computer listen' and never on 'computer finish'", () => {
    const files = modelFiles("moonshine-base-en");
    const raw = readFileSync(fixture);
    const audio = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const config = parseConfig({
      triggers: [
        { phrase: "computer listen", action: { run: "x" } },
        { phrase: "computer finish", action: { run: "x" } },
      ],
    });

    let ms = 0;
    const events: ClipEvent[] = [];
    const pipeline = new Pipeline(config, createSegmenter(files), createTranscriber(files), {
      now: () => ms,
      onClip: (e) => events.push(e),
      onFire: () => {},
    });
    for (let i = 0; i < audio.length; i += CHUNK) {
      pipeline.feed(audio.subarray(i, Math.min(i + CHUNK, audio.length)));
      ms += 32;
    }

    const fired = events.filter((e) => e.outcome === "fired");
    expect(fired.filter((e) => e.trigger?.phrase === "computer listen").length).toBeGreaterThanOrEqual(3);
    expect(fired.filter((e) => e.trigger?.phrase === "computer finish")).toHaveLength(0);
  }, 60_000);
});
