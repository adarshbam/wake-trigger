#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, configPath, homeDir, loadConfig } from "./config";
import type { Config } from "./config";
import { downloadModels, modelFiles, modelsPresent } from "./models";
import { listDevices, openMic } from "./mic";
import { Pipeline } from "./pipeline";
import { runAction } from "./actions";
import { preset } from "./presets";
import { describeError, formatClip, formatFired, formatIgnored, formatNotRunning } from "./format";
import { acquireLock } from "./lock";
import { ProcessWatch } from "./processes";

const USAGE = `Usage: wake-trigger <command>

Commands:
  init [--preset default|handy] [--handy-path <exe>]   Write a starter config
  setup                                                Download speech models
  devices                                              List microphones
  test                                                 Listen and show what is heard (runs no actions)
  start                                                Listen and run actions
  --help                                               Show this text`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function init(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { preset: { type: "string", default: "default" }, "handy-path": { type: "string" } },
  });
  if (values.preset !== "default" && values.preset !== "handy") {
    fail(`Unknown preset "${values.preset}". Use "default" or "handy".`);
  }
  const file = configPath();
  if (fs.existsSync(file)) fail(`Config already exists: ${file}. Edit it, or delete it to start over.`);
  const handyPath = values["handy-path"];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(preset(values.preset, handyPath), null, 2) + "\n");
  console.log(`Wrote ${file}`);
  if (values.preset === "handy" && handyPath === undefined) {
    console.log(`Edit "run" in ${file} to the full path of handy.exe (or re-run init with --handy-path).`);
  }
}

async function setup(): Promise<void> {
  let model: Config["model"] = "moonshine-base-en";
  if (fs.existsSync(configPath())) {
    try {
      model = loadConfig().model;
    } catch (e) {
      if (e instanceof ConfigError) fail(e.message);
      throw e;
    }
  }
  // else: no config yet, use the default model
  if (modelsPresent(model)) {
    console.log(`Models for ${model} are already present.`);
    return;
  }
  let last = "";
  await downloadModels(model, (file, done, total) => {
    if (file !== last && last !== "") process.stdout.write("\n");
    last = file;
    const pct = total > 0 ? ` ${Math.floor((done / total) * 100)}%` : "";
    process.stdout.write(`\rDownloading ${file}${pct}   `);
  });
  if (last !== "") process.stdout.write("\n");
  console.log("Models ready.");
}

function devices(): void {
  const found = listDevices();
  if (found.length === 0) console.log("(no microphones found)");
  for (const d of found) console.log(d);
}

async function listen(mode: "test" | "start"): Promise<void> {
  const config = loadConfig();
  if (!modelsPresent(config.model)) fail("Models missing. Run: wake-trigger setup");
  if (mode === "start") {
    // Two listening copies would each fire on the same phrase.
    let lock;
    try {
      lock = acquireLock(path.join(homeDir(), "start.lock"));
    } catch (e) {
      fail(describeError(e));
    }
    process.on("exit", () => lock.release());
  }
  const watch = new ProcessWatch();
  const required = [...new Set(config.triggers.flatMap((t) => (t.requires === undefined ? [] : [t.requires])))];
  if (required.length > 0) {
    await watch.start();
    for (const name of required) {
      if (!watch.isRunning(name)) console.log(`Note: ${name} is not running. Its phrases are skipped until it is started.`);
    }
  }
  // Loaded lazily: the native library is slow to load and not needed by other commands.
  const { createSegmenter, createTranscriber } = await import("./recognizer");
  const files = modelFiles(config.model);
  const pipeline = new Pipeline(config, createSegmenter(files), createTranscriber(files), {
    now: Date.now,
    onClip: (e) => {
      if (mode === "test") console.log(formatClip(e));
      else if (e.trigger === null) return;
      else if (e.outcome === "fired") console.log(formatFired(new Date(), e.trigger, e.forced));
      else if (e.outcome === "not-running") console.log(formatNotRunning(new Date(), e.trigger));
      else if (e.outcome === "cooldown" || e.outcome === "blocked-by-state") {
        console.log(formatIgnored(new Date(), e.trigger, e.outcome));
      }
    },
    isRunning: (name) => watch.isRunning(name),
    onFire: (trigger) => {
      if (mode === "test") return;
      runAction(trigger.action).catch((e) =>
        console.error(`Action for "${trigger.phrase}" failed: ${e instanceof Error ? e.message : String(e)}`));
    },
  });

  const phrases = config.triggers.map((t) => `"${t.phrase}"`).join(", ");
  const mic = openMic(
    config.microphone,
    (samples) => {
      try {
        pipeline.feed(samples);
      } catch (e) {
        mic.stop();
        fail(`Internal error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    (e) => fail(`Microphone error: ${e.message}`),
  );
  console.log(`Listening on microphone "${config.microphone}" for ${phrases}. Press Ctrl+C to stop.`);
  process.on("SIGINT", () => {
    mic.stop();
    process.exit(0);
  });
}

function noArguments(command: string, rest: string[]): void {
  if (rest.length > 0) {
    console.error(`Unexpected argument "${rest[0]}" for "${command}".

${USAGE}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case undefined:
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    case "init": return init(rest);
    case "setup": noArguments(command, rest); return setup();
    case "devices": noArguments(command, rest); return devices();
    case "test":
    case "start": noArguments(command, rest); return listen(command);
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      process.exit(1);
  }
}

main().catch((e) => {
  fail(describeError(e));
});
