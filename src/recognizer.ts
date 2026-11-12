import * as sherpa from "sherpa-onnx-node";
import type { ModelFiles } from "./models";

export interface Segment { start: number; length: number }
export interface Segmenter { accept(samples: Float32Array): Segment[] }
export interface Transcriber { transcribe(samples: Float32Array): string }

const SAMPLE_RATE = 16000;
const WINDOW = 512;

export function createSegmenter(files: ModelFiles): Segmenter {
  const vad = new sherpa.Vad({
    sileroVad: {
      model: files.vad,
      threshold: 0.5,
      minSilenceDuration: 0.4,
      minSpeechDuration: 0.15,
      windowSize: WINDOW,
      maxSpeechDuration: 8,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: "cpu",
    debug: 0,
  }, 60);

  let pending = new Float32Array(0);

  return {
    accept(samples: Float32Array): Segment[] {
      const merged = new Float32Array(pending.length + samples.length);
      merged.set(pending, 0);
      merged.set(samples, pending.length);
      let offset = 0;
      while (merged.length - offset >= WINDOW) {
        vad.acceptWaveform(Float32Array.from(merged.subarray(offset, offset + WINDOW)));
        offset += WINDOW;
      }
      pending = merged.slice(offset);

      const out: Segment[] = [];
      while (!vad.isEmpty()) {
        const s = vad.front(false);
        vad.pop();
        out.push({ start: s.start, length: s.samples.length });
      }
      return out;
    },
  };
}

export function createTranscriber(files: ModelFiles): Transcriber {
  const asr = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      moonshine: { encoder: files.encoder, mergedDecoder: files.mergedDecoder },
      tokens: files.tokens,
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    },
  });

  return {
    transcribe(samples: Float32Array): string {
      const stream = asr.createStream();
      stream.acceptWaveform({ samples: Float32Array.from(samples), sampleRate: SAMPLE_RATE });
      asr.decode(stream);
      return asr.getResult(stream).text;
    },
  };
}
