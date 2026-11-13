import type { Trigger } from "./config";
import type { ClipEvent } from "./pipeline";

export function formatClip(e: ClipEvent): string {
  let line = `${e.seconds.toFixed(1)}s  level ${e.level.toFixed(3)}  "${e.text}"`;
  if (e.nearest !== null) line += `  nearest "${e.nearest.phrase}" (${e.nearest.distance})`;
  line += `  -> ${e.outcome}`;
  if (e.atEnd && e.trigger !== null) line += " (at end of speech)";
  if (e.nearMiss) line += "  (near miss)";
  if (e.level < 0.01) line += "  (input level is low; raise microphone volume)";
  return line;
}

export function formatTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatIgnored(d: Date, trigger: Trigger, reason: "cooldown" | "blocked-by-state"): string {
  return `[${formatTime(d)}] ignored "${trigger.phrase}" (${reason})`;
}

export function formatFired(d: Date, trigger: Trigger, forced: boolean): string {
  return `[${formatTime(d)}] fired "${trigger.phrase}"${forced ? " (forced by repeat)" : ""}`;
}

/**
 * A clip that was probably a phrase, misheard. The heard text is what to add as an alias.
 * From long speech only the last three words are shown: the rest is the speaker's own text, not a command.
 */
export function formatNearMiss(d: Date, e: ClipEvent): string {
  const closest = e.nearest === null ? "" : ` (closest "${e.nearest.phrase}", ${e.nearest.distance})`;
  const words = e.text.trim().split(/\s+/);
  const heard = e.outcome === "too-long" && words.length > 3 ? `... ${words.slice(-3).join(" ")}` : words.join(" ");
  return `[${formatTime(d)}] near miss: heard "${heard}"${closest}`;
}

export function formatLaunching(d: Date, trigger: Trigger): string {
  return `[${formatTime(d)}] starting ${trigger.requires} for "${trigger.phrase}"`;
}

export function formatNotRunning(d: Date, trigger: Trigger): string {
  return `[${formatTime(d)}] skipped "${trigger.phrase}" (${trigger.requires} is not running)`;
}

/** Error text with the cause appended: Node's fetch reports only "fetch failed" and keeps the reason in `cause`. */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? e.cause.message : "";
  return cause !== "" && !e.message.includes(cause) ? `${e.message}: ${cause}` : e.message;
}
