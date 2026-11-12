import * as fs from "node:fs";
import * as path from "node:path";

/** Folder whose contents Windows runs when the user signs in. */
export function startupDir(platform: NodeJS.Platform = process.platform, appData: string | undefined = process.env.APPDATA): string {
  if (platform !== "win32" || !appData) throw new Error("autostart is supported on Windows only in this version");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

export function launcherPath(dir: string = startupDir()): string {
  return path.join(dir, "wake-trigger.vbs");
}

/**
 * A small script for Windows Script Host. It starts `wake-trigger start` with no window (the 0)
 * and does not wait for it (the False). Output goes to the log file, because a hidden process has no console.
 */
export function launcherScript(nodePath: string, cliPath: string, logPath: string): string {
  for (const p of [nodePath, cliPath, logPath]) {
    if (p.includes('"')) throw new Error(`path must not contain a double quote: ${p}`);
  }
  const command = `cmd.exe /c ""${nodePath}" "${cliPath}" start >> "${logPath}" 2>&1"`;
  return [
    "' Created by: wake-trigger autostart enable. Remove with: wake-trigger autostart disable",
    `CreateObject("WScript.Shell").Run "${command.replace(/"/g, '""')}", 0, False`,
    "",
  ].join("\r\n");
}

export function enableAutostart(nodePath: string, cliPath: string, logPath: string, dir: string = startupDir()): string {
  const file = launcherPath(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, launcherScript(nodePath, cliPath, logPath));
  return file;
}

/** Returns true when a launcher was removed. */
export function disableAutostart(dir: string = startupDir()): boolean {
  const file = launcherPath(dir);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

export function autostartEnabled(dir: string = startupDir()): boolean {
  return fs.existsSync(launcherPath(dir));
}
