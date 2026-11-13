import { candidatesOf } from "./config";
import type { Config, Trigger } from "./config";
import { isMatch, nearest } from "./matcher";
import type { Candidate, Nearest } from "./matcher";
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
  /** True when the clip was longer than maxPhraseSeconds and only its end was transcribed and matched. */
  atEnd: boolean;
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
const SETTLE_SECONDS = 6;
const LAUNCH_ALLOWANCE_SECONDS = 6; // time for the launched process to appear, on top of launchWaitSeconds

export class Pipeline {
  private readonly candidates: Candidate[];
  private readonly state: GroupState;
  // Backing store holds up to 2 * KEEP samples; the newest KEEP are the "held" audio.
  private readonly store = new Float32Array(2 * KEEP);
  private storeLength = 0;
  private total = 0; // absolute count of samples fed so far
  private lastFire: number | null = null;
  private lastBlocked: { triggerIndex: number; at: number } | null = null;
  private noForceUntil = 0;
  private readonly launchingUntil = new Map<string, number>();

  constructor(
    private readonly config: Config,
    private readonly segmenter: Segmenter,
    private readonly transcriber: Transcriber,
    private readonly opts: PipelineOptions,
  ) {
    this.candidates = candidatesOf(config);
    this.state = new GroupState(config.maxOnSeconds, opts.now);
    for (const group of Object.keys(config.groups)) this.state.watch(group);
  }

  /** The app behind a watched group reported that it turned on or off. */
  observe(group: string, on: boolean): void {
    this.state.observe(group, on);
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

    const atEnd = seconds > this.config.maxPhraseSeconds;
    if (atEnd && !this.config.matchAtEnd) {
      this.opts.onClip({ text: "", seconds, level, nearest: null, outcome: "too-long", trigger: null, forced: false, atEnd: false });
      return;
    }

    // Long speech: a phrase said without a pause before it sits at the end of the clip.
    // Transcribe only the last maxPhraseSeconds and compare its last words with each phrase.
    const from = atEnd ? start + length - Math.round(this.config.maxPhraseSeconds * SAMPLE_RATE) : start - PAD;
    const clip = this.slice(
      Math.min(this.total, Math.max(held, from)),
      Math.min(this.total, Math.max(held, start + length + PAD)),
    );
    const text = this.transcriber.transcribe(clip);
    const n = atEnd ? nearestAtEnd(normalize(text), this.candidates) : nearest(normalize(text), this.candidates);
    const near = n === null ? null : { phrase: n.phrase, distance: n.distance };
    const report = (outcome: ClipEvent["outcome"], trigger: Trigger | null, forced = false) =>
      this.opts.onClip({ text, seconds, level, nearest: near, outcome, trigger, forced, atEnd });

    if (n === null || !isMatch(n, this.config.tolerance)) return report(atEnd ? "too-long" : "no-match", null);
    const trigger = this.config.triggers[n.triggerIndex];
    const t = this.opts.now();
    if (this.lastFire !== null && t - this.lastFire < this.config.cooldownSeconds * 1000) return report("cooldown", trigger);
    const missing = trigger.requires !== undefined && this.opts.isRunning !== undefined &&
      !this.opts.isRunning(trigger.requires);
    // A closed app has nothing on. Not while we are starting it, though: then it is expected to be missing.
    if (missing && trigger.group !== undefined && t >= (this.launchingUntil.get(trigger.group) ?? 0)) {
      this.state.reset(trigger.group);
    }
    if (missing && (trigger.launch === undefined || this.opts.onLaunch === undefined)) return report("not-running", trigger);
    const watched = trigger.group !== undefined && this.state.isObserved(trigger.group);
    let forced = false;
    if (!this.state.allows(trigger)) {
      // A watched group knows the app's real state, so a repeat is never needed to correct it and never forces.
      if (watched) return report("blocked-by-state", trigger);
      // The tool only remembers what it sent; the app may have been stopped or started another way.
      // Saying the same phrase again soon after it was ignored overrides that memory.
      // Not right after a fire, though: a speaker who repeats the phrase because the app is slow to react
      // would undo the start. Repeats in that settling time are ignored and do not count toward a force.
      if (t < this.noForceUntil) return report("blocked-by-state", trigger);
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
    const launchMs = missing ? (this.config.launchWaitSeconds + LAUNCH_ALLOWANCE_SECONDS) * 1000 : 0;
    const confirmMs = watched ? this.config.groups[trigger.group!].confirmSeconds * 1000 + launchMs : 0;
    this.state.apply(trigger, confirmMs);
    this.lastFire = this.opts.now();
    if (missing && trigger.group !== undefined) this.launchingUntil.set(trigger.group, this.lastFire + launchMs);
    // Settling time: the app needs a moment to react, longer when it has to be started first.
    this.noForceUntil = this.lastFire + (SETTLE_SECONDS + (missing ? this.config.launchWaitSeconds + LAUNCH_ALLOWANCE_SECONDS : 0)) * 1000;
    report(missing ? "launching" : "fired", trigger, forced);
  }
}

/** Best match between the last words of the text and the phrases, comparing like with like in word count. */
function nearestAtEnd(text: string, candidates: Candidate[]): Nearest | null {
  if (text === "") return null;
  const words = text.split(" ");
  const found: Nearest[] = [];
  for (const count of new Set(candidates.map((c) => c.phrase.split(" ").length))) {
    const sameLength = candidates.filter((c) => c.phrase.split(" ").length === count);
    const n = nearest(words.slice(-count).join(" "), sameLength);
    if (n !== null) found.push(n);
  }
  if (found.length === 0) return null;
  const best = found.reduce((a, b) => (b.distance < a.distance ? b : a));
  const tie = found.some((n) => n.distance === best.distance && n.triggerIndex !== best.triggerIndex);
  return tie ? { ...best, ambiguous: true } : best;
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}
