import * as fs from "node:fs";

/**
 * Follows a text log file that another program appends to, and hands over each new complete line.
 * Polling, not fs.watch: it is simple and works the same on every platform and for files that do not exist yet.
 * A file that shrinks was truncated or replaced (the program restarted), so reading starts again from its top.
 */
export class LogWatch {
  private position = 0;
  private rest = "";
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly onLine: (line: string) => void,
    private readonly intervalMs = 250,
  ) {}

  /**
   * Reads the last `tailBytes` of the file so the caller learns the current state from the latest lines,
   * then keeps following the file.
   */
  start(tailBytes = 256 * 1024): void {
    const size = this.size();
    this.position = size === null ? 0 : Math.max(0, size - tailBytes);
    // Starting mid-file can land inside a line; that partial first line is dropped.
    this.poll(this.position > 0);
    this.timer = setInterval(() => this.poll(false), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reads whatever was appended since the last call. Public so tests can drive it without timers. */
  poll(dropFirstLine = false): void {
    const size = this.size();
    if (size === null) {
      this.position = 0;
      this.rest = "";
      return;
    }
    if (size < this.position) {
      this.position = 0;
      this.rest = "";
    }
    if (size === this.position) return;
    let text: string;
    try {
      const fd = fs.openSync(this.file, "r");
      try {
        const buffer = Buffer.alloc(size - this.position);
        const read = fs.readSync(fd, buffer, 0, buffer.length, this.position);
        text = buffer.subarray(0, read).toString("utf8");
        this.position += read;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return; // locked or gone for a moment; try again on the next poll
    }
    const lines = (this.rest + text).split(/\r?\n/);
    this.rest = lines.pop() ?? "";
    if (dropFirstLine) lines.shift();
    for (const line of lines) this.onLine(line);
  }

  private size(): number | null {
    try {
      return fs.statSync(this.file).size;
    } catch {
      return null;
    }
  }
}
