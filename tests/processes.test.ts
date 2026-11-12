import { describe, expect, it } from "vitest";
import { ProcessWatch, parseProcessList } from "../src/processes";

describe("parseProcessList", () => {
  it("reads image names from Windows tasklist CSV", () => {
    const out = '"System Idle Process","0","Services","0","8 K"\r\n"Handy.exe","21872","Console","1","50,584 K"\r\n\r\n';
    expect(parseProcessList(out, "win32")).toEqual(["system idle process", "handy.exe"]);
  });

  it("reads command names from ps output", () => {
    expect(parseProcessList("/usr/bin/Handy\nnode\n", "linux")).toEqual(["handy", "node"]);
  });
});

describe("ProcessWatch", () => {
  it("answers from the latest listing, ignoring case", async () => {
    let names = ["handy.exe"];
    const watch = new ProcessWatch(async () => names);
    await watch.refresh();
    expect(watch.isRunning("Handy.exe")).toBe(true);
    expect(watch.isRunning("other.exe")).toBe(false);
    names = [];
    await watch.refresh();
    expect(watch.isRunning("handy.exe")).toBe(false);
  });

  it("counts everything as running before the first listing and when listing fails", async () => {
    const watch = new ProcessWatch(async () => { throw new Error("no tasklist"); });
    expect(watch.isRunning("handy.exe")).toBe(true);
    await watch.refresh();
    expect(watch.isRunning("handy.exe")).toBe(true);
  });
});
