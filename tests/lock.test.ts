import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireLock } from "../src/lock";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-lock-"));
  file = path.join(dir, "home", "start.lock");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("acquireLock", () => {
  it("writes the process id and removes the file on release", () => {
    const lock = acquireLock(file, 111, () => true);
    expect(fs.readFileSync(file, "utf8")).toBe("111");
    lock.release();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses while another live copy holds the lock", () => {
    acquireLock(file, 111, () => true);
    expect(() => acquireLock(file, 222, () => true)).toThrow(/already running \(process 111\)/);
    expect(fs.readFileSync(file, "utf8")).toBe("111");
  });

  it("replaces a lock whose owner is dead", () => {
    acquireLock(file, 111, () => true);
    acquireLock(file, 222, (pid) => pid !== 111);
    expect(fs.readFileSync(file, "utf8")).toBe("222");
  });

  it("replaces a lock file with garbage in it", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not a pid");
    acquireLock(file, 222, () => true);
    expect(fs.readFileSync(file, "utf8")).toBe("222");
  });

  it("release leaves a lock that now belongs to another copy", () => {
    const first = acquireLock(file, 111, () => true);
    acquireLock(file, 222, () => false);
    first.release();
    expect(fs.readFileSync(file, "utf8")).toBe("222");
  });
});
