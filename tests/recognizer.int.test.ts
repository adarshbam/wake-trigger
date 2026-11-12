import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { modelFiles, modelsPresent } from "../src/models";
import { normalize } from "../src/normalize";
import { createSegmenter, createTranscriber } from "../src/recognizer";

const fixture = path.join(__dirname, "fixtures", "listen.f32");
const PAD = 4800;

describe.skipIf(!modelsPresent("moonshine-base-en") || !existsSync(fixture))("recogniser (real models)", () => {
  it("segments real speech and transcribes the clips", () => {
    const files = modelFiles("moonshine-base-en");
    const raw = readFileSync(fixture);
    const audio = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

    const segmenter = createSegmenter(files);
    const segments = [];
    for (let i = 0; i < audio.length; i += 700) {
      segments.push(...segmenter.accept(audio.subarray(i, Math.min(i + 700, audio.length))));
    }
    expect(segments.length).toBeGreaterThan(0);
    for (const s of segments) {
      expect(s.length).toBeGreaterThan(0);
      expect(s.start).toBeGreaterThanOrEqual(0);
    }

    const transcriber = createTranscriber(files);
    const texts = segments.map((s) => {
      const from = Math.max(0, s.start - PAD);
      const to = Math.min(audio.length, s.start + s.length + PAD);
      return normalize(transcriber.transcribe(audio.slice(from, to)));
    });
    expect(texts.some((t) => t.length > 0)).toBe(true);
    expect(texts).toContain("computer listen");
  }, 60_000);

  it("gives the same segments when the VAD is rebased early", () => {
    const files = modelFiles("moonshine-base-en");
    const raw = readFileSync(fixture);
    const audio = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const run = (segmenter: ReturnType<typeof createSegmenter>) => {
      const out = [];
      for (let i = 0; i < audio.length; i += 700) {
        out.push(...segmenter.accept(audio.subarray(i, Math.min(i + 700, audio.length))));
      }
      return out;
    };
    const normal = run(createSegmenter(files));
    const rebased = run(createSegmenter(files, 16000));
    expect(normal.length).toBeGreaterThan(0);
    expect(rebased).toHaveLength(normal.length);
    rebased.forEach((s, i) => {
      expect(Math.abs(s.start - normal[i].start)).toBeLessThanOrEqual(512);
    });
  }, 60_000);
});
