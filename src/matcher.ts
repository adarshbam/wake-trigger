import { editDistance } from "./normalize";

export interface Candidate { triggerIndex: number; phrase: string }
export interface Nearest { triggerIndex: number; phrase: string; distance: number; ambiguous: boolean }

export function nearest(text: string, candidates: Candidate[]): Nearest | null {
  if (candidates.length === 0 || text === "") return null;
  let best: Candidate | null = null;
  let bestDistance = Infinity;
  const tied = new Set<number>();
  for (const c of candidates) {
    const extra = text.length - c.phrase.length;
    const d = text.startsWith(c.phrase) && extra <= 3 ? Math.min(1, extra) : editDistance(text, c.phrase);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
      tied.clear();
      tied.add(c.triggerIndex);
    } else if (d === bestDistance) {
      tied.add(c.triggerIndex);
    }
  }
  return { triggerIndex: best!.triggerIndex, phrase: best!.phrase, distance: bestDistance, ambiguous: tied.size > 1 };
}

export function isMatch(n: Nearest | null, tolerance: number): boolean {
  return n !== null && !n.ambiguous && n.distance <= tolerance;
}
