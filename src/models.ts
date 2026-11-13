import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { homeDir } from "./config";
import type { Config } from "./config";

/** Where a model's files are on disk. The shape depends on the kind of model. */
export type ModelFiles =
  | { kind: "nemoCtc"; vad: string; model: string; tokens: string }
  | { kind: "moonshine"; vad: string; encoder: string; mergedDecoder: string; tokens: string };

interface ModelSpec {
  kind: ModelFiles["kind"];
  /** Archive name in the sherpa-onnx "asr-models" release. It holds one top folder with `files` in it. */
  archive: string;
  files: string[];
}

const BASE_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/";
const VAD_FILE = "silero_vad.onnx";
const MODELS: Record<Config["model"], ModelSpec> = {
  "parakeet-110m-en": {
    kind: "nemoCtc",
    archive: "sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2",
    files: ["model.int8.onnx", "tokens.txt"],
  },
  "moonshine-base-en": {
    kind: "moonshine",
    archive: "sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2",
    files: ["encoder_model.ort", "decoder_model_merged.ort", "tokens.txt"],
  },
  "moonshine-tiny-en": {
    kind: "moonshine",
    archive: "sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2",
    files: ["encoder_model.ort", "decoder_model_merged.ort", "tokens.txt"],
  },
};

function defaultRoot(): string {
  return path.join(homeDir(), "models");
}

export function modelFiles(model: Config["model"], root: string = defaultRoot()): ModelFiles {
  const dir = path.join(root, model);
  const vad = path.join(root, VAD_FILE);
  const tokens = path.join(dir, "tokens.txt");
  if (MODELS[model].kind === "nemoCtc") return { kind: "nemoCtc", vad, model: path.join(dir, "model.int8.onnx"), tokens };
  return {
    kind: "moonshine",
    vad,
    encoder: path.join(dir, "encoder_model.ort"),
    mergedDecoder: path.join(dir, "decoder_model_merged.ort"),
    tokens,
  };
}

/** The speech model's own files, without the shared voice-activity model. */
function speechModelPaths(model: Config["model"], root: string): string[] {
  return MODELS[model].files.map((name) => path.join(root, model, name));
}

export function modelsPresent(model: Config["model"], root: string = defaultRoot()): boolean {
  return [path.join(root, VAD_FILE), ...speechModelPaths(model, root)].every((p) => fs.existsSync(p));
}

type Progress = (file: string, done: number, total: number) => void;

async function downloadTo(url: string, dest: string, name: string, onProgress: Progress, fetchFn: typeof fetch): Promise<void> {
  const part = dest + ".part";
  try {
    const res = await fetchFn(url);
    if (res.status !== 200) throw new Error(`download of ${name} failed: HTTP ${res.status}`);
    if (!res.body) throw new Error(`download of ${name} failed: empty response`);
    const header = res.headers.get("content-length");
    const total = header === null ? 0 : Number(header);
    let done = 0;
    const progress = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        done += chunk.length;
        onProgress(name, done, total);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>), progress, fs.createWriteStream(part));
    if (header !== null && done !== total) {
      throw new Error(`download of ${name} incomplete: got ${done} of ${total} bytes`);
    }
    fs.renameSync(part, dest);
  } catch (e) {
    fs.rmSync(part, { recursive: true, force: true });
    throw e;
  }
}

function extract(archive: string, dir: string, cwd: string): Promise<void> {
  // Relative paths and cwd: GNU tar would read "C:" in an absolute path as a remote host.
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xf", path.relative(cwd, archive), "--strip-components=1", "-C", path.relative(cwd, dir)], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", (e) => reject(new Error(`the system "tar" command is required to unpack models: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed with exit code ${code}: ${err.trim()}`));
    });
  });
}

export async function downloadModels(
  model: Config["model"],
  onProgress: Progress,
  root: string = defaultRoot(),
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  fs.mkdirSync(root, { recursive: true });
  const vad = path.join(root, VAD_FILE);
  if (!fs.existsSync(vad)) {
    await downloadTo(BASE_URL + VAD_FILE, vad, VAD_FILE, onProgress, fetchFn);
  }

  const wanted = speechModelPaths(model, root);
  if (wanted.every((p) => fs.existsSync(p))) return;

  const spec = MODELS[model];
  const finalDir = path.join(root, model);
  const tmpDir = finalDir + ".tmp";
  const archive = path.join(root, spec.archive);
  try {
    await downloadTo(BASE_URL + spec.archive, archive, spec.archive, onProgress, fetchFn);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir);
    await extract(archive, tmpDir, root);
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, finalDir);
    if (!wanted.every((p) => fs.existsSync(p))) {
      fs.rmSync(finalDir, { recursive: true, force: true });
      throw new Error(`archive did not contain ${spec.files.join(" / ")}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
  }
}
