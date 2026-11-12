import * as sherpa from "sherpa-onnx-node";
import type { ModelFiles } from "./models";

export interface Segment { start: number; length: number }
export interface Segmenter { accept(samples: Float32Array): Segment[] }
export interface Transcriber { transcribe(samples: Float32Array): string }

const SAMPLE_RATE = 16000;
const WINDOW = 512;
const CONTEXT = 16; // windows replayed into a fresh Vad (0.5 s)

export function createSegmenter(files: ModelFiles, rebaseAfterSamples: number = 2 ** 30): Segmenter {
  const makeVad = () => new sherpa.Vad({
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

  let vad = makeVad();
  let pending = new Float32Array(0);
  // The native VAD may count samples in 32 bits (about 37 hours at 16 kHz). To keep
  // Segment.start correct on very long runs, a fresh Vad replaces the old one when it is
  // idle after many samples. `offset` is the absolute index of the fresh Vad's sample 0.
  // The VAD dates a segment back to where speech began, so the fresh Vad first gets the
  // last CONTEXT windows again; that way speech just starting is not cut. Those windows
  // are all silence, because the swap waits for CONTEXT idle windows in a row.
  let fed = 0; // samples fed to the current Vad
  let offset = 0; // absolute index of the current Vad's sample 0
  const recent: Float32Array[] = []; // the last CONTEXT windows fed
  let quiet = 0; // idle windows in a row

  return {
    accept(samples: Float32Array): Segment[] {
      const merged = new Float32Array(pending.length + samples.length);
      merged.set(pending, 0);
      merged.set(samples, pending.length);
      const out: Segment[] = [];
      const drain = () => {
        while (!vad.isEmpty()) {
          const s = vad.front(false);
          vad.pop();
          out.push({ start: offset + s.start, length: s.samples.length });
        }
      };
      let pos = 0;
      while (merged.length - pos >= WINDOW) {
        const window = Float32Array.from(merged.subarray(pos, pos + WINDOW));
        pos += WINDOW;
        vad.acceptWaveform(window);
        fed += WINDOW;
        recent.push(window);
        if (recent.length > CONTEXT) recent.shift();
        quiet = !vad.isDetected() && vad.isEmpty() ? quiet + 1 : 0;
        if (quiet >= CONTEXT && fed - recent.length * WINDOW > rebaseAfterSamples) {
          vad = makeVad();
          quiet = 0;
          offset += fed - recent.length * WINDOW;
          for (const w of recent) vad.acceptWaveform(w);
          fed = recent.length * WINDOW;
        }
      }
      pending = merged.slice(pos);
      drain();
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
