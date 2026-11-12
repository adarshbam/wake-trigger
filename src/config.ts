import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalize, editDistance } from "./normalize";
import type { Candidate } from "./matcher";
import { toSendKeys } from "./actions";

export type Action = { run: string; args?: string[] } | { keys: string };
export interface Trigger { phrase: string; aliases: string[]; group?: string; sets?: "on" | "off"; action: Action }
export interface Config {
  microphone: string;
  model: "moonshine-base-en" | "moonshine-tiny-en";
  tolerance: number;
  maxPhraseSeconds: number;
  cooldownSeconds: number;
  maxOnSeconds: number;
  triggers: Trigger[];
}

export class ConfigError extends Error {}

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function number(obj: Obj, key: string, def: number, positive: boolean): number {
  const v = obj[key];
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isFinite(v) || (positive ? v <= 0 : v < 0)) {
    throw new ConfigError(`${key} must be a finite number ${positive ? "> 0" : ">= 0"}`);
  }
  return v;
}

function rejectUnknown(obj: Obj, allowed: string[], prefix: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new ConfigError(`unknown field "${prefix}${key}"`);
  }
}

function nonEmptyString(v: unknown, field: string): string {
  if (typeof v !== "string" || v === "") throw new ConfigError(`${field} must be a non-empty string`);
  return v;
}

function phrase(v: unknown, field: string): string {
  if (typeof v !== "string" || normalize(v) === "") {
    throw new ConfigError(`${field} must be a string with at least one letter`);
  }
  return v;
}

function parseAction(v: unknown, field: string): Action {
  if (!isObject(v)) throw new ConfigError(`${field} must be an object with "run" or "keys"`);
  const hasRun = v.run !== undefined;
  const hasKeys = v.keys !== undefined;
  if (hasRun === hasKeys) throw new ConfigError(`${field} must have exactly one of "run" or "keys"`);
  rejectUnknown(v, hasKeys ? ["keys"] : ["run", "args"], `${field}.`);
  if (hasKeys) {
    const keys = nonEmptyString(v.keys, `${field}.keys`);
    try {
      toSendKeys(keys);
    } catch (e) {
      throw new ConfigError(`${field}.keys: ${(e as Error).message}`);
    }
    return { keys };
  }
  const run = nonEmptyString(v.run, `${field}.run`);
  if (v.args === undefined) return { run };
  if (!Array.isArray(v.args) || !v.args.every((a) => typeof a === "string")) {
    throw new ConfigError(`${field}.args must be an array of strings`);
  }
  return { run, args: [...v.args] };
}

function parseTrigger(v: unknown, i: number): Trigger {
  const f = `triggers[${i}]`;
  if (!isObject(v)) throw new ConfigError(`${f} must be an object`);
  rejectUnknown(v, ["phrase", "aliases", "group", "sets", "action"], `${f}.`);
  const p = phrase(v.phrase, `${f}.phrase`);
  let aliases: string[] = [];
  if (v.aliases !== undefined) {
    if (!Array.isArray(v.aliases)) throw new ConfigError(`${f}.aliases must be an array of strings`);
    aliases = v.aliases.map((a, j) => phrase(a, `${f}.aliases[${j}]`));
  }
  const trigger: Trigger = { phrase: p, aliases, action: parseAction(v.action, `${f}.action`) };
  if (v.group !== undefined) trigger.group = nonEmptyString(v.group, `${f}.group`);
  if (v.sets !== undefined) {
    if (v.sets !== "on" && v.sets !== "off") throw new ConfigError(`${f}.sets must be "on" or "off"`);
    trigger.sets = v.sets;
  }
  if (trigger.group !== undefined && trigger.sets === undefined) {
    throw new ConfigError(`${f}.sets is required when ${f}.group is set`);
  }
  if (trigger.sets !== undefined && trigger.group === undefined) {
    throw new ConfigError(`${f}.group is required when ${f}.sets is set`);
  }
  return trigger;
}

export function parseConfig(raw: unknown): Config {
  if (!isObject(raw)) throw new ConfigError("config must be a JSON object");
  rejectUnknown(raw, ["microphone", "model", "tolerance", "maxPhraseSeconds", "cooldownSeconds", "maxOnSeconds", "triggers"], "");
  const microphone = raw.microphone === undefined ? "default" : nonEmptyString(raw.microphone, "microphone");
  const model = raw.model === undefined ? "moonshine-base-en" : raw.model;
  if (model !== "moonshine-base-en" && model !== "moonshine-tiny-en") {
    throw new ConfigError(`model must be "moonshine-base-en" or "moonshine-tiny-en"`);
  }
  const tolerance = number(raw, "tolerance", 2, false);
  const maxPhraseSeconds = number(raw, "maxPhraseSeconds", 3, true);
  const cooldownSeconds = number(raw, "cooldownSeconds", 1.5, false);
  const maxOnSeconds = number(raw, "maxOnSeconds", 300, true);
  if (!Array.isArray(raw.triggers) || raw.triggers.length === 0) {
    throw new ConfigError("triggers must be a non-empty array");
  }
  const triggers = raw.triggers.map(parseTrigger);
  const config: Config = { microphone, model, tolerance, maxPhraseSeconds, cooldownSeconds, maxOnSeconds, triggers };

  const cands = candidatesOf(config);
  for (let a = 0; a < cands.length; a++) {
    for (let b = a + 1; b < cands.length; b++) {
      if (cands[a].triggerIndex === cands[b].triggerIndex) continue;
      if (editDistance(cands[a].phrase, cands[b].phrase) <= tolerance) {
        throw new ConfigError(
          `"${cands[a].phrase}" (triggers[${cands[a].triggerIndex}]) and "${cands[b].phrase}" ` +
          `(triggers[${cands[b].triggerIndex}]) are too similar for tolerance ${tolerance}`);
      }
    }
  }
  return config;
}

export function candidatesOf(config: Config): Candidate[] {
  const out: Candidate[] = [];
  config.triggers.forEach((t, triggerIndex) => {
    for (const p of [t.phrase, ...t.aliases]) out.push({ triggerIndex, phrase: normalize(p) });
  });
  return out;
}

export function homeDir(): string {
  const override = process.env.WAKE_TRIGGER_HOME;
  if (override) return override;
  return path.join(os.homedir(), ".wake-trigger");
}

export function configPath(): string {
  return path.join(homeDir(), "config.json");
}

export function loadConfig(file: string = configPath()): Config {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`config file not found: ${file}. Run \`wake-trigger init\` to create it.`);
    }
    throw new ConfigError(`cannot read config file ${file}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`invalid JSON in ${file}: ${(e as Error).message}`);
  }
  return parseConfig(raw);
}
