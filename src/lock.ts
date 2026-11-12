import * as fs from "node:fs";
import * as path from "node:path";

export interface Lock { release(): void }

/** Is a process with this id alive? EPERM means it exists but belongs to someone else. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the single-instance lock. Two copies listening at once both fire on the same phrase,
 * which sends a toggle-only app two toggles: it starts and stops in the same instant.
 * A lock left behind by a copy that was killed is detected by its dead process id and replaced.
 */
export function acquireLock(file: string, pid: number = process.pid, isAlive: (pid: number) => boolean = processAlive): Lock {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(pid), { flag: "wx" });
      return {
        release() {
          try {
            if (fs.readFileSync(file, "utf8").trim() === String(pid)) fs.rmSync(file);
          } catch {
            // already gone
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const owner = Number(fs.readFileSync(file, "utf8").trim());
      if (Number.isInteger(owner) && owner > 0 && owner !== pid && isAlive(owner)) {
        throw new Error(`wake-trigger is already running (process ${owner}). Stop that copy first.`);
      }
      fs.rmSync(file, { force: true }); // stale: owner is dead or the file is garbage
    }
  }
  throw new Error(`could not take the lock file ${file}`);
}

/** Process id of the live copy that holds the lock, or null. */
export function lockOwner(file: string, isAlive: (pid: number) => boolean = processAlive): number | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : null;
}
