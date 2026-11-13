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

  it("rejects when writing to disk fails and leaves no .part file", async () => {
    // A directory where the .part file must go makes opening it for writing fail (EISDIR).
    fs.mkdirSync(path.join(root, "silero_vad.onnx.part"), { recursive: true });
    await expect(downloadModels("moonshine-tiny-en", () => {}, root, okFetch())).rejects.toThrow(/EISDIR|illegal operation/);
    expect(leftovers()).toEqual([]);
  });

  it("rejects an archive that lacks a model file and leaves no model directory", async () => {
    fs.rmSync(path.join(work, "src", "sherpa-onnx-moonshine-test", "tokens.txt"));
    const r = spawnSync("tar", ["-cjf", "test.tar.bz2", "-C", "src", "sherpa-onnx-moonshine-test"], { cwd: work });
    if (r.status !== 0) throw new Error("cannot build test archive: " + String(r.stderr));
    archive = fs.readFileSync(path.join(work, "test.tar.bz2"));
    await expect(downloadModels("moonshine-tiny-en", () => {}, root, okFetch())).rejects.toThrow(
      "archive did not contain encoder_model.ort / decoder_model_merged.ort / tokens.txt");
    expect(fs.existsSync(path.join(root, "moonshine-tiny-en"))).toBe(false);
    expect(leftovers()).toEqual([]);
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

describe("parakeet-110m-en", () => {
  it("has one model file and tokens, in its own folder", () => {
    const f = modelFiles("parakeet-110m-en", root);
    expect(f).toEqual({
      kind: "nemoCtc",
      vad: path.join(root, "silero_vad.onnx"),
      model: path.join(root, "parakeet-110m-en", "model.int8.onnx"),
      tokens: path.join(root, "parakeet-110m-en", "tokens.txt"),
    });
    expect(modelFiles("moonshine-base-en", root).kind).toBe("moonshine");
  });

  it("is present only when the voice-activity model and both of its files exist", () => {
    const f = modelFiles("parakeet-110m-en", root);
    if (f.kind !== "nemoCtc") throw new Error("unexpected kind");
    fs.mkdirSync(path.dirname(f.model), { recursive: true });
    fs.writeFileSync(f.vad, "");
    fs.writeFileSync(f.model, "");
    expect(modelsPresent("parakeet-110m-en", root)).toBe(false);
    fs.writeFileSync(f.tokens, "");
    expect(modelsPresent("parakeet-110m-en", root)).toBe(true);
    expect(modelsPresent("moonshine-base-en", root)).toBe(false);
  });

  it("downloads its own archive and names its files when the archive is wrong", async () => {
    const calls: string[] = [];
    // The test archive holds Moonshine file names, so it is the wrong layout for this model.
    await expect(downloadModels("parakeet-110m-en", () => {}, root, okFetch(calls))).rejects.toThrow(
      "archive did not contain model.int8.onnx / tokens.txt");
    expect(calls.at(-1)).toBe(
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2");
    expect(fs.existsSync(path.join(root, "parakeet-110m-en"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });
});
