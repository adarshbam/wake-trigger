import { execFile } from "node:child_process";
import * as path from "node:path";

/** Names of all running processes, lower case (for example "handy.exe"). No shell is used. */
export function listProcessNames(platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const [cmd, args] = platform === "win32"
    ? ["tasklist", ["/FO", "CSV", "/NH"]]
    : ["ps", ["-A", "-o", "comm="]];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(parseProcessList(stdout, platform));
    });
  });
}

export function parseProcessList(stdout: string, platform: NodeJS.Platform): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (platform === "win32") {
      const m = /^"([^"]+)"/.exec(line); // first CSV column is the image name
      if (m) names.push(m[1].toLowerCase());
    } else {
      names.push(path.basename(line.trim()).toLowerCase());
    }
  }
  return names;
}

/**
 * Keeps a recent answer to "is this process running?" so the audio path never waits on a process listing.
 * If the listing itself fails, every name counts as running: a broken check must not silence the tool.
 */
export class ProcessWatch {
  private running: Set<string> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly list: () => Promise<string[]> = listProcessNames,
    private readonly intervalMs = 2000,
  ) {}

  /** Does the first listing, then keeps refreshing in the background. */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(name: string): boolean {
    return this.running === null || this.running.has(name.toLowerCase());
  }

  /** Refreshes until the process is running or the time is up. Resolves to whether it is running. */
  async waitFor(name: string, timeoutMs: number, stepMs = 500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.refresh();
      if (this.running !== null && this.running.has(name.toLowerCase())) return true;
      if (this.running === null || Date.now() >= deadline) return this.running === null;
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }

  async refresh(): Promise<void> {
    try {
      this.running = new Set(await this.list());
    } catch {
      this.running = null;
    }
  }
}
