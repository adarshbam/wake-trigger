import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { playSound, toSendKeys, runAction, type Spawn } from "../src/actions";

type Call = { cmd: string; args: string[]; opts: Record<string, unknown> };

function makeFake(behaviour: (child: EventEmitter) => void) {
  const calls: Call[] = [];
  const fake = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {};
    process.nextTick(() => behaviour(child));
    return child;
  }) as unknown as Spawn;
  return { fake, calls };
}

const spawns = (c: EventEmitter) => c.emit("spawn");
const exits = (code: number) => (c: EventEmitter) => c.emit("exit", code, null);
const enoent = (c: EventEmitter) => c.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));

describe("toSendKeys", () => {
  it("maps modifiers and space", () => {
    expect(toSendKeys("ctrl+shift+space")).toBe("^+ ");
  });
  it("maps function keys", () => {
    expect(toSendKeys("alt+f4")).toBe("%{F4}");
  });
  it("maps letters", () => {
    expect(toSendKeys("ctrl+a")).toBe("^a");
  });
  it("maps named keys", () => {
    expect(toSendKeys("enter")).toBe("{ENTER}");
    expect(toSendKeys("escape")).toBe("{ESC}");
  });
  it("is case and whitespace tolerant", () => {
    expect(toSendKeys(" Ctrl + A ")).toBe("^a");
  });
  it("throws naming the unknown key", () => {
    expect(() => toSendKeys("ctrl+banana")).toThrow(/banana/);
  });
  it("throws for the win key", () => {
    expect(() => toSendKeys("win+r")).toThrow(/win/);
  });
  it("throws for inherited property names as a key", () => {
    expect(() => toSendKeys("constructor")).toThrow(/constructor/);
  });
  it("throws for inherited property names as a modifier", () => {
    expect(() => toSendKeys("ctrl+constructor+a")).toThrow(/constructor/);
  });
  it("throws for an empty string", () => {
    expect(() => toSendKeys("")).toThrow(Error);
  });
});

describe("runAction", () => {
  it("spawns a program without a shell, detached", async () => {
    const { fake, calls } = makeFake(spawns);
    await runAction({ run: "C:\\app.exe", args: ["--toggle"] }, fake, "win32");
    expect(calls[0]).toMatchObject({ cmd: "C:\\app.exe", args: ["--toggle"], opts: { shell: false, detached: true, stdio: "ignore" } });
  });
  it("rejects with the program path when the child errors", async () => {
    const { fake } = makeFake(enoent);
    await expect(runAction({ run: "C:\\missing.exe" }, fake, "win32")).rejects.toThrow(/missing\.exe/);
  });
  it("rejects keys on non-Windows platforms", async () => {
    const { fake } = makeFake(exits(0));
    await expect(runAction({ keys: "ctrl+a" }, fake, "linux")).rejects.toThrow(/Windows only/);
  });
  it("sends keys through powershell on Windows", async () => {
    const { fake, calls } = makeFake(exits(0));
    await runAction({ keys: "ctrl+a" }, fake, "win32");
    expect(calls.at(-1)!.cmd).toBe("powershell");
    expect(calls.at(-1)!.args.join(" ")).toContain("SendWait('^a')");
    expect(calls.at(-1)!.opts).toMatchObject({ shell: false });
  });
  it("rejects keys when powershell exits non-zero", async () => {
    const { fake } = makeFake(exits(1));
    await expect(runAction({ keys: "ctrl+a" }, fake, "win32")).rejects.toThrow(/exit/);
  });
  it("rejects (not throws) on an invalid key combination", async () => {
    const { fake } = makeFake(exits(0));
    await expect(runAction({ keys: "win+r" }, fake, "win32")).rejects.toThrow(/win/);
  });
});

describe("playSound", () => {
  function recorder() {
    const calls: { cmd: string; args: string[] }[] = [];
    const fn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { on() { return this; }, unref() {} };
    }) as unknown as Spawn;
    return { calls, fn };
  }
  it("beeps through powershell on Windows, higher for accepted than for stopped", () => {
    const r = recorder();
    playSound("accepted", r.fn, "win32");
    playSound("stopped", r.fn, "win32");
    expect(r.calls.map((c) => c.cmd)).toEqual(["powershell", "powershell"]);
    expect(r.calls[0].args.at(-1)).toBe("[console]::beep(880,120)");
    expect(r.calls[1].args.at(-1)).toBe("[console]::beep(520,120)");
  });
  it("does nothing on other platforms and never throws", () => {
    const r = recorder();
    playSound("accepted", r.fn, "linux");
    expect(r.calls).toEqual([]);
    expect(() => playSound("accepted", (() => { throw new Error("no powershell"); }) as unknown as Spawn, "win32")).not.toThrow();
  });
});
