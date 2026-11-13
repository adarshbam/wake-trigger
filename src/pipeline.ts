import { candidatesOf } from "./config";
import type { Config, Trigger } from "./config";
import { isMatch, nearest } from "./matcher";
import type { Candidate } from "./matcher";
import { normalize } from "./normalize";
import type { Segmenter, Transcriber } from "./recognizer";
import { GroupState } from "./state";

export interface ClipEvent {
  text: string; seconds: number; level: number;
  nearest: { phrase: string; distance: number } | null;
  outcome: "fired" | "no-match" | "too-long" | "cooldown" | "blocked-by-state" | "not-running" | "launching";
  trigger: Trigger | null;
  /** True when a fire happened only because the phrase was repeated after being blocked by state. */
  forced: boolean;
}
export interface PipelineOptions {
  now: () => number;
  onClip: (e: ClipEvent) => void;
  onFire: (t: Trigger) => void;
  /** Is the named process running? Used for triggers with `requires`. Omitted: every process counts as running. */
  isRunning?: (name: string) => boolean;
  /**
   * Called instead of onFire when the trigger's required process is not running and the trigger has `launch`.
   * The receiver starts the program and then runs the action. Omitted: such a trigger is skipped as not-running.
   */
  onLaunch?: (t: Trigger) => void;
}

const SAMPLE_RATE = 16000;
const KEEP = 15 * SAMPLE_RATE;
const PAD = 4800;

export class Pipeline {
  private readonly candidates: Candidate[];
  private readonly state: GroupState;
  // Backing store holds up to 2 * KEEP samples; the newest KEEP are the "held" audio.
  private readonly store = new Float32Array(2 * KEEP);
  private storeLength = 0;
  private total = 0; // absolute count of samples fed so far
  private lastFire: number | null = null;
  private lastBlocked: { triggerIndex: number; at: number } | null = null;

  constructor(
    private readonly config: Config,
    private readonly segmenter: Segmenter,
    private readonly transcriber: Transcriber,
    private readonly opts: PipelineOptions,
  ) {
    this.candidates = candidatesOf(config);
    this.state = new GroupState(config.maxOnSeconds, opts.now);
  }

  feed(samples: Float32Array): void {
    this.append(samples);
    for (const segment of this.segmenter.accept(samples)) this.handle(segment.start, segment.length);
  }

  private append(samples: Float32Array): void {
    const input = samples.length > KEEP ? samples.subarray(samples.length - KEEP) : samples;
    if (this.storeLength + input.length > this.store.length) {
      const keep = Math.min(this.storeLength, KEEP - input.length);
      this.store.copyWithin(0, this.storeLength - keep, this.storeLength);
      this.storeLength = keep;
    }
    this.store.set(input, this.storeLength);
    this.storeLength += input.length;
    this.total += samples.length;
  }

  private heldStart(): number {
    return this.total - Math.min(this.storeLength, KEEP);
  }

  private slice(from: number, to: number): Float32Array {
    const base = this.total - this.storeLength;
    return this.store.slice(from - base, to - base);
  }

  private handle(start: number, length: number): void {
    const held = this.heldStart();
    const seconds = length / SAMPLE_RATE;
    const unpadded = this.slice(Math.min(this.total, Math.max(held, start)), Math.min(this.total, Math.max(held, start + length)));
    const level = rms(unpadded);

    if (seconds > this.config.maxPhraseSeconds) {
      this.opts.onClip({ text: "", seconds, level, nearest: null, outcome: "too-long", trigger: null, forced: false });
      return;
    }

    const clip = this.slice(
      Math.min(this.total, Math.max(held, start - PAD)),
      Math.min(this.total, Math.max(held, start + length + PAD)),
    );
    const text = this.transcriber.transcribe(clip);
    const n = nearest(normalize(text), this.candidates);
    const near = n === null ? null : { phrase: n.phrase, distance: n.distance };
    const report = (outcome: ClipEvent["outcome"], trigger: Trigger | null, forced = false) =>
      this.opts.onClip({ text, seconds, level, nearest: near, outcome, trigger, forced });

    if (n === null || !isMatch(n, this.config.tolerance)) return report("no-match", null);
    const trigger = this.config.triggers[n.triggerIndex];
    const t = this.opts.now();
    if (this.lastFire !== null && t - this.lastFire < this.config.cooldownSeconds * 1000) return report("cooldown", trigger);
    const missing = trigger.requires !== undefined && this.opts.isRunning !== undefined &&
      !this.opts.isRunning(trigger.requires);
    if (missing && (trigger.launch === undefined || this.opts.onLaunch === undefined)) return report("not-running", trigger);
    let forced = false;
    if (!this.state.allows(trigger)) {
      // The tool only remembers what it sent; the app may have been stopped or started another way.
      // Saying the same phrase again soon after it was ignored overrides that memory.
      const b = this.lastBlocked;
      forced = b !== null && b.triggerIndex === n.triggerIndex && this.config.forceRepeatSeconds > 0 &&
        t - b.at <= this.config.forceRepeatSeconds * 1000;
      if (!forced) {
        this.lastBlocked = { triggerIndex: n.triggerIndex, at: t };
        return report("blocked-by-state", trigger);
      }
    }

    this.lastBlocked = null;
    if (missing) this.opts.onLaunch!(trigger);
    else this.opts.onFire(trigger);
    this.state.apply(trigger);
    this.lastFire = this.opts.now();
    report(missing ? "launching" : "fired", trigger, forced);
  }
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}
