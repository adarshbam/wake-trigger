#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, configPath, homeDir, loadConfig } from "./config";
import type { Config, Trigger } from "./config";
import { downloadModels, modelFiles, modelsPresent } from "./models";
import { listDevices, openMic } from "./mic";
import { Pipeline } from "./pipeline";
import { runAction } from "./actions";
import { preset } from "./presets";
import { describeError, formatClip, formatFired, formatIgnored, formatLaunching, formatNotRunning } from "./format";
import { acquireLock, lockOwner } from "./lock";
import { autostartEnabled, disableAutostart, enableAutostart } from "./autostart";
import { ProcessWatch } from "./processes";

const USAGE = `Usage: wake-trigger <command>

Commands:
  init [--preset default|handy] [--handy-path <exe>]   Write a starter config
  setup                                                Download speech models
  devices                                              List microphones
  test                                                 Listen and show what is heard (runs no actions)
  start                                                Listen and run actions
  stop                                                 Stop the running copy
  status                                               Show whether it is running and starts at sign-in
  autostart enable|disable                             Start hidden at Windows sign-in, or stop doing so
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
  try {
    await downloadModels(model, (file, done, total) => {
      if (file !== last && last !== "") process.stdout.write("\n");
      last = file;
      const pct = total > 0 ? ` ${Math.floor((done / total) * 100)}%` : "";
      process.stdout.write(`\rDownloading ${file}${pct}   `);
    });
  } finally {
    if (last !== "") process.stdout.write("\n"); // end the in-place progress line, also before an error message
  }
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
      lock = acquireLock(lockFile());
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
      if (watch.isRunning(name)) continue;
      const canLaunch = config.triggers.some((t) => t.requires === name && t.launch !== undefined);
      console.log(canLaunch
        ? `Note: ${name} is not running. It is started when you say a phrase that has "launch".`
        : `Note: ${name} is not running. Its phrases are skipped until it is started.`);
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
      else if (e.outcome === "launching") console.log(formatLaunching(new Date(), e.trigger));
      else if (e.outcome === "cooldown" || e.outcome === "blocked-by-state") {
        console.log(formatIgnored(new Date(), e.trigger, e.outcome));
      }
    },
    isRunning: (name) => watch.isRunning(name),
    onLaunch: (trigger) => {
      if (mode === "test") return;
      launchThenRun(trigger, watch, config.launchWaitSeconds).catch((e) =>
        console.error(`Starting ${trigger.requires} for "${trigger.phrase}" failed: ${describeError(e)}`));
    },
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

const lockFile = () => path.join(homeDir(), "start.lock");
const logFile = () => path.join(homeDir(), "wake-trigger.log");

function stop(): void {
  const pid = lockOwner(lockFile());
  if (pid === null) {
    console.log("wake-trigger is not running.");
    return;
  }
  process.kill(pid);
  fs.rmSync(lockFile(), { force: true }); // a killed process cannot remove its own lock
  console.log(`Stopped wake-trigger (process ${pid}).`);
}

function status(): void {
  const pid = lockOwner(lockFile());
  console.log(pid === null ? "Running: no" : `Running: yes (process ${pid})`);
  let auto: string;
  try {
    auto = autostartEnabled() ? "yes" : "no";
  } catch {
    auto = "not supported on this system";
  }
  console.log(`Starts at sign-in: ${auto}`);
  console.log(`Log when started at sign-in: ${logFile()}`);
}

function autostart(rest: string[]): void {
  const [action, ...extra] = rest;
  if (extra.length > 0 || (action !== "enable" && action !== "disable")) {
    console.error(`Use: wake-trigger autostart enable|disable

${USAGE}`);
    process.exit(1);
  }
  if (action === "disable") {
    console.log(disableAutostart() ? "Autostart removed. A copy that is running now keeps running; use: wake-trigger stop"
      : "Autostart was not enabled.");
    return;
  }
  loadConfig(); // refuse to autostart something that cannot start
  fs.mkdirSync(homeDir(), { recursive: true });
  // process.execPath and this file: the exact node and build that are running now.
  const file = enableAutostart(process.execPath, __filename, logFile());
  console.log(`Autostart enabled: ${file}`);
  console.log(`At each sign-in wake-trigger starts hidden and writes to ${logFile()}`);
  console.log("It is not started now. Start it with: wake-trigger start   Stop it with: wake-trigger stop");
}

/** The required program is closed: start it, wait until it is up and ready, then send the action. */
async function launchThenRun(trigger: Trigger, watch: ProcessWatch, waitSeconds: number): Promise<void> {
  if (trigger.launch === undefined || trigger.requires === undefined) return;
  await runAction(trigger.launch);
  if (!(await watch.waitFor(trigger.requires, 30_000))) {
    throw new Error(`${trigger.requires} did not appear within 30 seconds`);
  }
  await new Promise((r) => setTimeout(r, waitSeconds * 1000));
  await runAction(trigger.action);
  console.log(formatFired(new Date(), trigger, false));
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
    case "stop": noArguments(command, rest); return stop();
    case "status": noArguments(command, rest); return status();
    case "autostart": return autostart(rest);
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
