import type { Trigger } from "./config";
import type { ClipEvent } from "./pipeline";

export function formatClip(e: ClipEvent): string {
  let line = `${e.seconds.toFixed(1)}s  level ${e.level.toFixed(3)}  "${e.text}"`;
  if (e.nearest !== null) line += `  nearest "${e.nearest.phrase}" (${e.nearest.distance})`;
  line += `  -> ${e.outcome}`;
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

/** Error text with the cause appended: Node's fetch reports only "fetch failed" and keeps the reason in `cause`. */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? e.cause.message : "";
  return cause !== "" && !e.message.includes(cause) ? `${e.message}: ${cause}` : e.message;
}
