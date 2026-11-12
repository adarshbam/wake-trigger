import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { autostartEnabled, disableAutostart, enableAutostart, launcherPath, launcherScript, startupDir } from "../src/autostart";
import { acquireLock, lockOwner } from "../src/lock";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-auto-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("launcherScript", () => {
  it("runs start hidden, without waiting, with output appended to the log", () => {
    const s = launcherScript("C:/Program Files/nodejs/node.exe", "C:/p/dist/cli.js", "C:/h/wake-trigger.log");
    const line = s.split("\r\n")[1];
    expect(line).toBe(
      'CreateObject("WScript.Shell").Run "cmd.exe /c """"C:/Program Files/nodejs/node.exe"" ""C:/p/dist/cli.js"" start >> ""C:/h/wake-trigger.log"" 2>&1""", 0, False');
  });

  it("refuses a path containing a double quote", () => {
    expect(() => launcherScript('C:/a"b/node.exe', "c", "l")).toThrow(/double quote/);
  });
});

describe("startupDir", () => {
  it("is the per-user Startup folder on Windows", () => {
    expect(startupDir("win32", "C:/Users/u/AppData/Roaming"))
      .toBe(path.join("C:/Users/u/AppData/Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup"));
  });
  it("gives a clear error elsewhere", () => {
    expect(() => startupDir("linux", undefined)).toThrow(/Windows only/);
  });
});

describe("enable and disable", () => {
  it("writes and removes the launcher", () => {
    expect(autostartEnabled(dir)).toBe(false);
    const file = enableAutostart("node.exe", "cli.js", "log.txt", dir);
    expect(file).toBe(launcherPath(dir));
    expect(autostartEnabled(dir)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("wake-trigger autostart disable");
    expect(disableAutostart(dir)).toBe(true);
    expect(disableAutostart(dir)).toBe(false);
    expect(autostartEnabled(dir)).toBe(false);
  });
});

describe("lockOwner", () => {
  it("returns the live owner, and null for no file, a dead owner or garbage", () => {
    const file = path.join(dir, "start.lock");
    expect(lockOwner(file)).toBeNull();
    acquireLock(file, 111, () => true);
    expect(lockOwner(file, () => true)).toBe(111);
    expect(lockOwner(file, () => false)).toBeNull();
    fs.writeFileSync(file, "junk");
    expect(lockOwner(file, () => true)).toBeNull();
  });
});
