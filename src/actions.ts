import { spawn } from "node:child_process";
import type { Action } from "./config";

export type Spawn = typeof import("node:child_process").spawn;

/** A short beep as feedback. Windows only; elsewhere it does nothing. Never rejects: a missing sound must not matter. */
export function playSound(kind: "accepted" | "stopped", spawnFn: Spawn = spawn, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") return;
  const [frequency, ms] = kind === "accepted" ? [880, 120] : [520, 120];
  try {
    const child = spawnFn("powershell", ["-NoProfile", "-NonInteractive", "-Command", `[console]::beep(${frequency},${ms})`],
      { shell: false, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // no sound
  }
}

const MODIFIERS: Record<string, string> = { ctrl: "^", shift: "+", alt: "%" };

const NAMED_KEYS: Record<string, string> = {
  enter: "{ENTER}",
  escape: "{ESC}",
  tab: "{TAB}",
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  home: "{HOME}",
  end: "{END}",
  space: " ",
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`f${i}`] = `{F${i}}`;

/**
 * Convert a combination like "ctrl+shift+space" to a SendKeys string ("^+ ").
 * Limits of SendKeys: it cannot press the Windows key and cannot tell left
 * Ctrl/Shift/Alt from right.
 */
export function toSendKeys(keys: string): string {
  const parts = keys.split("+").map((p) => p.trim().toLowerCase());
  const key = parts[parts.length - 1];
  let out = "";
  for (const mod of parts.slice(0, -1)) {
    const code = Object.hasOwn(MODIFIERS, mod) ? MODIFIERS[mod] : undefined;
    if (code === undefined) throw new Error(`Unknown modifier "${mod}" in keys "${keys}" (supported: ctrl, shift, alt)`);
    out += code;
  }
  if (Object.hasOwn(NAMED_KEYS, key)) return out + NAMED_KEYS[key];
  if (/^[a-z0-9]$/.test(key)) return out + key;
  throw new Error(`Unknown key "${key}" in keys "${keys}"`);
}

function runProgram(action: { run: string; args?: string[] }, spawnFn: Spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(action.run, action.args ?? [], { shell: false, detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", (err) => reject(new Error(`Could not start "${action.run}": ${err.message}`)));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function sendKeys(keys: string, spawnFn: Spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    const sendKeysString = toSendKeys(keys).replace(/'/g, "''");
    const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKeysString}')`;
    const child = spawnFn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { shell: false, stdio: "ignore", windowsHide: true });
    child.once("error", (err) => reject(new Error(`Could not send keys "${keys}": ${err.message}`)));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Sending keys "${keys}" failed: powershell exit code ${code}`));
    });
  });
}

export async function runAction(action: Action, spawnFn: Spawn = spawn, platform: NodeJS.Platform = process.platform): Promise<void> {
  if ("run" in action) return runProgram(action, spawnFn);
  if (platform !== "win32") throw new Error("keys actions are supported on Windows only in this version");
  return sendKeys(action.keys, spawnFn);
}
