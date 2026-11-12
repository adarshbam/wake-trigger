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
