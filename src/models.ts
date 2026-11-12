import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { homeDir } from "./config";
import type { Config } from "./config";

export interface ModelFiles { vad: string; encoder: string; mergedDecoder: string; tokens: string }

const BASE_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/";
const VAD_FILE = "silero_vad.onnx";
const ARCHIVES: Record<Config["model"], string> = {
  "moonshine-base-en": "sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2",
  "moonshine-tiny-en": "sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2",
};

function defaultRoot(): string {
  return path.join(homeDir(), "models");
}

export function modelFiles(model: Config["model"], root: string = defaultRoot()): ModelFiles {
  const dir = path.join(root, model);
  return {
    vad: path.join(root, VAD_FILE),
    encoder: path.join(dir, "encoder_model.ort"),
    mergedDecoder: path.join(dir, "decoder_model_merged.ort"),
    tokens: path.join(dir, "tokens.txt"),
  };
}

export function modelsPresent(model: Config["model"], root: string = defaultRoot()): boolean {
  return Object.values(modelFiles(model, root)).every((p) => fs.existsSync(p));
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
    const out = fs.createWriteStream(part);
    let done = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
        done += chunk.length;
        onProgress(name, done, total);
      }
    } finally {
      await new Promise<void>((resolve) => out.end(resolve));
    }
    if (header !== null && done !== total) {
      throw new Error(`download of ${name} incomplete: got ${done} of ${total} bytes`);
    }
    fs.renameSync(part, dest);
  } catch (e) {
    fs.rmSync(part, { force: true });
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
  const files = modelFiles(model, root);

  if (!fs.existsSync(files.vad)) {
    await downloadTo(BASE_URL + VAD_FILE, files.vad, VAD_FILE, onProgress, fetchFn);
  }

  const modelPresent = [files.encoder, files.mergedDecoder, files.tokens].every((p) => fs.existsSync(p));
  if (modelPresent) return;

  const finalDir = path.join(root, model);
  const tmpDir = finalDir + ".tmp";
  const archiveName = ARCHIVES[model];
  const archive = path.join(root, archiveName);
  try {
    await downloadTo(BASE_URL + archiveName, archive, archiveName, onProgress, fetchFn);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir);
    await extract(archive, tmpDir, root);
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, finalDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
  }
}
