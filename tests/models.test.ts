import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { downloadModels, modelFiles, modelsPresent } from "../src/models";

let root: string;
let work: string;
let archive: Buffer;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "wt-models-"));
  root = path.join(work, "models");
  const src = path.join(work, "src");
  const top = path.join(src, "sherpa-onnx-moonshine-test");
  fs.mkdirSync(top, { recursive: true });
  fs.writeFileSync(path.join(top, "encoder_model.ort"), "enc");
  fs.writeFileSync(path.join(top, "decoder_model_merged.ort"), "dec");
  fs.writeFileSync(path.join(top, "tokens.txt"), "tok");
  const out = path.join(work, "test.tar.bz2");
  const r = spawnSync("tar", ["-cjf", "test.tar.bz2", "-C", "src", "sherpa-onnx-moonshine-test"], { cwd: work });
  if (r.status !== 0) throw new Error("cannot build test archive: " + String(r.stderr));
  archive = fs.readFileSync(out);
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function bodyResponse(chunks: Buffer[], opts: { length?: number | null; status?: number; failAfter?: boolean } = {}): Response {
  const total = opts.length === undefined ? chunks.reduce((n, c) => n + c.length, 0) : opts.length;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new Uint8Array(c));
      if (opts.failAfter) controller.error(new Error("connection reset"));
      else controller.close();
    },
  });
  const headers: Record<string, string> = {};
  if (total !== null) headers["content-length"] = String(total);
  return new Response(stream, { status: opts.status ?? 200, headers });
}

function okFetch(calls: string[] = []): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("silero_vad.onnx")) return bodyResponse([Buffer.from("vad-body")]);
    const half = Math.floor(archive.length / 2);
    return bodyResponse([archive.subarray(0, half), archive.subarray(half)]);
  }) as typeof fetch;
}

function leftovers(): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((n) => n.endsWith(".part") || n.endsWith(".tmp") || n.endsWith(".tar.bz2"));
}

function touchAll(model: "moonshine-base-en" | "moonshine-tiny-en"): void {
  const f = modelFiles(model, root);
  fs.mkdirSync(path.dirname(f.encoder), { recursive: true });
  for (const p of [f.vad, f.encoder, f.mergedDecoder, f.tokens]) fs.writeFileSync(p, "");
}

describe("modelFiles / modelsPresent", () => {
  it("builds the file paths under root", () => {
    const f = modelFiles("moonshine-base-en", root);
    expect(f.vad).toBe(path.join(root, "silero_vad.onnx"));
    expect(f.encoder).toBe(path.join(root, "moonshine-base-en", "encoder_model.ort"));
    expect(f.mergedDecoder).toBe(path.join(root, "moonshine-base-en", "decoder_model_merged.ort"));
    expect(f.tokens).toBe(path.join(root, "moonshine-base-en", "tokens.txt"));
  });

  it("is false when missing, true with all four files, false after one is deleted", () => {
    expect(modelsPresent("moonshine-base-en", root)).toBe(false);
    touchAll("moonshine-base-en");
    expect(modelsPresent("moonshine-base-en", root)).toBe(true);
    fs.rmSync(modelFiles("moonshine-base-en", root).tokens);
    expect(modelsPresent("moonshine-base-en", root)).toBe(false);
  });
});

describe("downloadModels", () => {
  it("downloads and extracts all files and leaves no temporary files", async () => {
    const calls: string[] = [];
    await downloadModels("moonshine-tiny-en", () => {}, root, okFetch(calls));
    expect(modelsPresent("moonshine-tiny-en", root)).toBe(true);
    expect(fs.readFileSync(modelFiles("moonshine-tiny-en", root).encoder, "utf8")).toBe("enc");
    expect(leftovers()).toEqual([]);
    expect(calls).toContain(
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2");
    expect(calls).toContain("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx");
  });

  it("rejects on a non-200 status and leaves nothing behind", async () => {
    const f: typeof fetch = (async () => bodyResponse([Buffer.from("x")], { status: 404 })) as typeof fetch;
    await expect(downloadModels("moonshine-tiny-en", () => {}, root, f)).rejects.toThrow(/404/);
    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(modelFiles("moonshine-tiny-en", root).vad)).toBe(false);
  });

  it("rejects when the stream errors midway and leaves nothing behind", async () => {
    const f: typeof fetch = (async (input: unknown) => {
      if (String(input).endsWith("silero_vad.onnx")) return bodyResponse([Buffer.from("vad-body")]);
      return bodyResponse([archive.subarray(0, 10)], { failAfter: true, length: archive.length });
    }) as typeof fetch;
    await expect(downloadModels("moonshine-tiny-en", () => {}, root, f)).rejects.toThrow(/connection reset/);
    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(path.join(root, "moonshine-tiny-en"))).toBe(false);
  });

  it("rejects when fewer bytes arrive than content-length", async () => {
    const f: typeof fetch = (async (input: unknown) => {
      if (String(input).endsWith("silero_vad.onnx")) return bodyResponse([Buffer.from("vad-body")], { length: 100 });
      return bodyResponse([archive]);
    }) as typeof fetch;
    await expect(downloadModels("moonshine-tiny-en", () => {}, root, f)).rejects.toThrow(/incomplete/);
    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(modelFiles("moonshine-tiny-en", root).vad)).toBe(false);
  });

  it("skips items that are already present", async () => {
    touchAll("moonshine-tiny-en");
    fs.rmSync(path.join(root, "moonshine-tiny-en"), { recursive: true });
    const calls: string[] = [];
    await downloadModels("moonshine-tiny-en", () => {}, root, okFetch(calls));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("moonshine-tiny-en");

    const none: string[] = [];
    await downloadModels("moonshine-tiny-en", () => {}, root, okFetch(none));
    expect(none).toEqual([]);
  });

  it("reports progress with file name and increasing done", async () => {
    const events: Array<[string, number, number]> = [];
    await downloadModels("moonshine-tiny-en", (file, done, total) => events.push([file, done, total]), root, okFetch());
    const arch = events.filter((e) => e[0].includes("moonshine-tiny-en"));
    expect(arch.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < arch.length; i++) expect(arch[i][1]).toBeGreaterThan(arch[i - 1][1]);
    expect(arch[arch.length - 1][1]).toBe(archive.length);
    expect(arch[0][2]).toBe(archive.length);
    expect(events.some((e) => e[0] === "silero_vad.onnx")).toBe(true);
  });
});
