import type { Trigger } from "./config";

interface Observed {
  /** Last state reported by the app itself. */
  actual: boolean;
  /** What we just asked for, trusted until the app confirms it or the time runs out. */
  pending: { value: boolean; until: number } | null;
}

/**
 * On/off state per group.
 *
 * A plain group only remembers what the tool sent, and returns to off after maxOnSeconds.
 * An observed group follows the app's own events (see `observe`). What the tool sent is then only a
 * short-lived expectation: if the app does not confirm it in time, the app's real state stands again,
 * so saying the phrase once more tries again, and saying it many times can never undo it.
 */
export class GroupState {
  private readonly turnedOnAt = new Map<string, number>();
  private readonly observed = new Map<string, Observed>();

  constructor(private readonly maxOnSeconds: number, private readonly now: () => number) {}

  /** Mark a group as following the app's own events. It starts off. */
  watch(group: string): void {
    if (!this.observed.has(group)) this.observed.set(group, { actual: false, pending: null });
  }

  isObserved(group: string): boolean {
    return this.observed.has(group);
  }

  /** The app reported its state. This always wins over what the tool expected. */
  observe(group: string, on: boolean): void {
    const o = this.observed.get(group);
    if (o === undefined) return;
    o.actual = on;
    o.pending = null;
  }

  /** The app is closed, so nothing can be on. */
  reset(group: string): void {
    this.turnedOnAt.delete(group);
    const o = this.observed.get(group);
    if (o !== undefined) {
      o.actual = false;
      o.pending = null;
    }
  }

  allows(t: Trigger): boolean {
    if (t.group === undefined) return true;
    if (t.sets === "on") return !this.isOn(t.group);
    if (t.sets === "off") return this.isOn(t.group);
    return true;
  }

  /** Call after the trigger fired. For an observed group, confirmMs is how long to wait for the app to confirm. */
  apply(t: Trigger, confirmMs = 0): void {
    if (t.group === undefined || t.sets === undefined) return;
    const o = this.observed.get(t.group);
    if (o !== undefined) {
      o.pending = { value: t.sets === "on", until: this.now() + confirmMs };
      return;
    }
    if (t.sets === "on") this.turnedOnAt.set(t.group, this.now());
    else this.turnedOnAt.delete(t.group);
  }

  private isOn(group: string): boolean {
    const o = this.observed.get(group);
    if (o !== undefined) {
      if (o.pending !== null && this.now() < o.pending.until) return o.pending.value;
      o.pending = null;
      return o.actual;
    }
    const at = this.turnedOnAt.get(group);
    return at !== undefined && this.now() - at <= this.maxOnSeconds * 1000;
  }
}
