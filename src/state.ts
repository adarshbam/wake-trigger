import type { Trigger } from "./config";

export class GroupState {
  private readonly turnedOnAt = new Map<string, number>();

  constructor(private readonly maxOnSeconds: number, private readonly now: () => number) {}

  allows(t: Trigger): boolean {
    if (t.group === undefined) return true;
    if (t.sets === "on") return !this.isOn(t.group);
    if (t.sets === "off") return this.isOn(t.group);
    return true;
  }

  apply(t: Trigger): void {
    if (t.group === undefined) return;
    if (t.sets === "on") this.turnedOnAt.set(t.group, this.now());
    else if (t.sets === "off") this.turnedOnAt.delete(t.group);
  }

  private isOn(group: string): boolean {
    const at = this.turnedOnAt.get(group);
    return at !== undefined && this.now() - at <= this.maxOnSeconds * 1000;
  }
}
