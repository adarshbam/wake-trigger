# wake-trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A command-line program that listens to the microphone and runs a configured action (run a command or press a hotkey) when it hears a configured spoken phrase.

**Architecture:** Microphone samples go to a voice-activity detector that cuts one clip per utterance; short clips are transcribed by a small local speech model; the text is fuzzy-matched against configured phrases; a small state machine decides whether the trigger may fire; the action runs. The pipeline depends on two injected interfaces (`Segmenter`, `Transcriber`) so all logic is unit-tested with fakes and the native speech library is confined to one file.

**Tech Stack:** Node.js >= 20, TypeScript 5 compiled to CommonJS, `sherpa-onnx-node` (Silero VAD + Moonshine), `@picovoice/pvrecorder-node` (microphone, Apache-2.0, no access key), `vitest`.

**Spec:** `docs/superpowers/specs/2026-11-12-wake-trigger-design.md`

## Global Constraints

- Free, open-source dependencies only. No account, key, or network use except `setup` downloading models.
- No audio is written to disk. No audio or text leaves the machine.
- Home directory: `~/.wake-trigger/` (config at `config.json`, models under `models/`). The path is short on purpose: Windows paths over 260 characters break model loading.
- Defaults, verbatim from the spec: `tolerance` 2, `maxPhraseSeconds` 3, `cooldownSeconds` 1.5, `maxOnSeconds` 300, clip padding 0.3 s before and after, default model `moonshine-base-en`, default phrases "computer listen" and "computer finish".
- Audio format everywhere inside the program: 16 000 Hz, mono, `Float32Array` in the range -1..1.
- `run` actions never use a shell.
- A stop trigger (`sets: "off"`) heard while its group is off is ignored.
- Windows 11 is the tested platform. Do not add code that only works on Windows without a clear error on other platforms.
- English only. MIT licence. Package name `wake-trigger`, binary `wake-trigger`.
- TDD: write the failing test first for every pure module. Commit after each task.

## Review Focus

1. Microphone missing, or unplugged while running: the program prints a clear error and exits with code 1. It never hangs silently. (Task 2)
2. A phrase written with capitals or punctuation in config (`"Computer, Listen!"`) matches the same as `"computer listen"`. (Task 4)
3. Two triggers whose phrases are within `tolerance` edits of each other: config is rejected at start with a message naming both phrases, because either could fire for the other. (Task 4)
4. An action whose program does not exist: the error is logged and the program keeps listening. (Task 6)
5. Model download interrupted: no half-written model is left where `start` would load it; `start` and `test` say "run `wake-trigger setup`" when models are missing. (Task 7)

## File Structure

| File | Responsibility |
|---|---|
| `src/normalize.ts` | Text to lower-case letters and single spaces. |
| `src/matcher.ts` | Edit distance; nearest phrase; match decision. |
| `src/config.ts` | Config types, validation, loading, paths. |
| `src/state.ts` | Group on/off state with timeout. |
| `src/actions.ts` | Run a command; press a hotkey. |
| `src/models.ts` | Model registry, presence check, download. |
| `src/mic.ts` | Microphone devices and capture. |
| `src/recognizer.ts` | The only file that imports `sherpa-onnx-node`. |
| `src/pipeline.ts` | Clip handling: pad, length gate, transcribe, match, state, cooldown. |
| `src/presets.ts` | Starter configs (default, Handy). |
| `src/cli.ts` | Commands: `init`, `setup`, `devices`, `test`, `start`. |
| `tests/*.test.ts` | One test file per pure module. |

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`, `src/index.ts`, `tests/smoke.test.ts`

- [ ] **Step 1: Initialise**

`git init`. `package.json`: name `wake-trigger`, version `0.1.0`, licence `MIT`, `"engines": {"node": ">=20"}`, `"bin": {"wake-trigger": "dist/cli.js"}`, `"files": ["dist"]`, scripts `build` (`tsc`), `test` (`vitest run`), `dev` (`tsx src/cli.ts`). Dev dependencies: `typescript`, `vitest`, `tsx`, `@types/node`. `tsconfig.json`: `target` ES2022, `module` CommonJS, `strict` true, `rootDir` `src`, `outDir` `dist`, `esModuleInterop` true. `.gitignore`: `node_modules`, `dist`, `tests/fixtures/*.f32`. `LICENSE`: MIT text, year 2026; ask the author for the copyright name.

- [ ] **Step 2: Smoke test**

`tests/smoke.test.ts` asserts `1 + 1 === 2`. Run `npm test`. Expected: 1 passed. Run `npm run build`. Expected: exit code 0.

- [ ] **Step 3: Commit**

`git add -A && git commit -m "chore: scaffold project"` (includes the existing `docs/` folder).

---

### Task 2: Microphone capture (main technical risk, do it first)

**Files:**
- Create: `src/mic.ts`, `scripts/mic-check.ts`

**Interfaces:**
- Produces:
  ```ts
  export function listDevices(): string[];
  export interface Mic { stop(): void }
  // device: "default" or a device name (exact, else case-insensitive substring).
  export function openMic(device: string, onSamples: (s: Float32Array) => void, onError: (e: Error) => void): Mic;
  ```

- [ ] **Step 1: Prove the library**

`npm install @picovoice/pvrecorder-node`. Read its README for the current API (expected: `PvRecorder.getAvailableDevices()`, `new PvRecorder(frameLength, deviceIndex)` with `-1` for default, `start()`, `await read()` returning `Int16Array` at 16 000 Hz, `stop()`, `release()`). If it does not install with a prebuilt Windows binary or needs any key, stop and report; fallback candidate is `naudiodon2`.

- [ ] **Step 2: Implement `src/mic.ts`**

Frame length 512. Read frames in a loop, convert `Int16` to `Float32` by dividing by 32768, call `onSamples`. Unknown device name: throw `Error` listing available devices. A read failure calls `onError` once and stops the loop. `stop()` ends the loop and releases the recorder.

- [ ] **Step 3: Manual check**

`scripts/mic-check.ts` prints the device list, opens the default mic for 5 seconds, prints the peak level each second. Run `npx tsx scripts/mic-check.ts` while speaking. Expected: device list non-empty; peak above 0.05 while speaking, below 0.02 in silence.

- [ ] **Step 4: Failure check (Review Focus 1)**

Run `mic-check` with a device name that does not exist. Expected: error message listing real devices, exit code 1. Start a capture, disable the microphone in Windows Sound settings. Expected: `onError` fires, process exits with code 1 within 5 seconds.

- [ ] **Step 5: Commit** `feat: microphone capture`

---

### Task 3: Normalise and match

**Files:**
- Create: `src/normalize.ts`, `src/matcher.ts`
- Test: `tests/normalize.test.ts`, `tests/matcher.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function normalize(text: string): string;
  export function editDistance(a: string, b: string): number;
  export interface Candidate { triggerIndex: number; phrase: string }   // phrase already normalised
  export interface Nearest { triggerIndex: number; phrase: string; distance: number; ambiguous: boolean }
  export function nearest(text: string, candidates: Candidate[]): Nearest | null;   // text already normalised; null when candidates is empty or text is ""
  export function isMatch(n: Nearest | null, tolerance: number): boolean;
  ```

- [ ] **Step 1: Failing tests**

```ts
expect(normalize("Computer, Listen!")).toBe("computer listen");
expect(normalize("  Stop   it. ")).toBe("stop it");
expect(normalize("1, 2")).toBe("");

expect(editDistance("computer stop", "computer stone")).toBe(2);
expect(editDistance("", "abc")).toBe(3);

const c = [{ triggerIndex: 0, phrase: "computer listen" }, { triggerIndex: 1, phrase: "computer finish" }];
expect(nearest("computer listen", c)).toMatchObject({ triggerIndex: 0, distance: 0, ambiguous: false });
expect(nearest("computer listening", c)).toMatchObject({ triggerIndex: 0, distance: 1 });   // prefix rule
expect(nearest("computer listen to me now", c)!.distance).toBeGreaterThan(2);               // prefix rule limited to 3 extra letters
expect(nearest("start the division", c)!.distance).toBeGreaterThan(2);
expect(nearest("", c)).toBeNull();
// same distance to two different triggers => ambiguous
expect(nearest("ab", [{ triggerIndex: 0, phrase: "aa" }, { triggerIndex: 1, phrase: "bb" }])!.ambiguous).toBe(true);
// same distance to a phrase and alias of ONE trigger => not ambiguous
expect(nearest("ab", [{ triggerIndex: 0, phrase: "aa" }, { triggerIndex: 0, phrase: "bb" }])!.ambiguous).toBe(false);

expect(isMatch({ triggerIndex: 0, phrase: "x", distance: 2, ambiguous: false }, 2)).toBe(true);
expect(isMatch({ triggerIndex: 0, phrase: "x", distance: 3, ambiguous: false }, 2)).toBe(false);
expect(isMatch({ triggerIndex: 0, phrase: "x", distance: 0, ambiguous: true }, 2)).toBe(false);
expect(isMatch(null, 2)).toBe(false);
```

- [ ] **Step 2: Run, expect FAIL** (`npm test`)

- [ ] **Step 3: Implement**

`normalize`: lower-case, remove everything except `a-z` and spaces, collapse spaces, trim. Distance to one candidate:

```ts
const extra = text.length - phrase.length;
const d = text.startsWith(phrase) && extra <= 3 ? Math.min(1, extra) : editDistance(text, phrase);
```

- [ ] **Step 4: Run, expect PASS.** **Step 5: Commit** `feat: text normalisation and phrase matching`

---

### Task 4: Config

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `normalize`, `editDistance`, `Candidate`
- Produces:
  ```ts
  export type Action = { run: string; args?: string[] } | { keys: string };
  export interface Trigger { phrase: string; aliases: string[]; group?: string; sets?: "on" | "off"; action: Action }
  export interface Config { microphone: string; model: "moonshine-base-en" | "moonshine-tiny-en"; tolerance: number;
    maxPhraseSeconds: number; cooldownSeconds: number; maxOnSeconds: number; triggers: Trigger[] }
  export class ConfigError extends Error {}
  export function parseConfig(raw: unknown): Config;          // applies defaults, throws ConfigError naming the field
  export function candidatesOf(config: Config): Candidate[];  // normalised phrase + aliases per trigger
  export function homeDir(): string;                          // path.join(os.homedir(), ".wake-trigger")
  export function configPath(): string;                       // homeDir()/config.json
  export function loadConfig(file?: string): Config;          // missing file => ConfigError telling the user to run `wake-trigger init`
  ```

- [ ] **Step 1: Failing tests**

```ts
const t = (phrase: string, extra = {}) => ({ phrase, action: { run: "x" }, ...extra });
const c = parseConfig({ triggers: [t("Computer, Listen!")] });
expect(c).toMatchObject({ microphone: "default", model: "moonshine-base-en", tolerance: 2,
  maxPhraseSeconds: 3, cooldownSeconds: 1.5, maxOnSeconds: 300 });
expect(c.triggers[0].aliases).toEqual([]);
expect(candidatesOf(c)).toEqual([{ triggerIndex: 0, phrase: "computer listen" }]);          // Review Focus 2

expect(() => parseConfig({ triggers: [] })).toThrow(/triggers/);
expect(() => parseConfig({ triggers: [t("!!!")] })).toThrow(/triggers\[0\]\.phrase/);
expect(() => parseConfig({ triggers: [t("a b", { group: "g" })] })).toThrow(/triggers\[0\]\.sets/);
expect(() => parseConfig({ triggers: [t("a b", { sets: "on" })] })).toThrow(/triggers\[0\]\.group/);
expect(() => parseConfig({ triggers: [{ phrase: "a b", action: {} }] })).toThrow(/triggers\[0\]\.action/);
expect(() => parseConfig({ triggers: [{ phrase: "a b", action: { run: "x", keys: "ctrl+a" } }] })).toThrow(/action/);
expect(() => parseConfig({ model: "whisper", triggers: [t("a b")] })).toThrow(/model/);
expect(() => parseConfig({ tolerance: -1, triggers: [t("a b")] })).toThrow(/tolerance/);
// Review Focus 3: phrases of different triggers closer than or equal to tolerance
expect(() => parseConfig({ triggers: [t("computer stop"), t("computer shop")] }))
  .toThrow(/computer stop.*computer shop|too similar/);
expect(() => parseConfig("nope")).toThrow(ConfigError);
```

- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement** by hand, no schema library. Numbers must be finite and >= 0 (`maxPhraseSeconds`, `maxOnSeconds` > 0). The similarity check compares every candidate of one trigger with every candidate of every other trigger using `editDistance <= tolerance`.

- [ ] **Step 4: Run, expect PASS.** **Step 5: Commit** `feat: config parsing and validation`

---

### Task 5: Group state

**Files:**
- Create: `src/state.ts`
- Test: `tests/state.test.ts`

**Interfaces:**
- Consumes: `Trigger`
- Produces:
  ```ts
  export class GroupState {
    constructor(maxOnSeconds: number, now: () => number);   // now() in milliseconds
    allows(t: Trigger): boolean;
    apply(t: Trigger): void;                                // call after the trigger fired
  }
  ```

- [ ] **Step 1: Failing tests** (fake clock `let ms = 0; const now = () => ms;`, `maxOnSeconds` 300)

```ts
const on = { phrase: "a", aliases: [], group: "g", sets: "on", action: { run: "x" } } as const;
const off = { ...on, sets: "off" } as const;
const free = { phrase: "b", aliases: [], action: { run: "x" } };
const s = new GroupState(300, now);
expect(s.allows(free)).toBe(true);
expect(s.allows(off)).toBe(false);          // stop while idle is ignored
expect(s.allows(on)).toBe(true);
s.apply(on);
expect(s.allows(on)).toBe(false);
expect(s.allows(off)).toBe(true);
s.apply(off);
expect(s.allows(on)).toBe(true);
s.apply(on); ms = 300_001;
expect(s.allows(on)).toBe(true);            // timed out back to off
expect(s.allows(off)).toBe(false);
// groups are independent
const other = { ...on, group: "h" };
s.apply(on); expect(s.allows(other)).toBe(true);
```

- [ ] **Step 2: FAIL. Step 3: Implement** (map of group name to the time it turned on). **Step 4: PASS. Step 5: Commit** `feat: group on/off state`

---

### Task 6: Actions

**Files:**
- Create: `src/actions.ts`
- Test: `tests/actions.test.ts`

**Interfaces:**
- Consumes: `Action`
- Produces:
  ```ts
  export function toSendKeys(keys: string): string;        // "ctrl+shift+space" -> "^+ " ; throws Error on unknown key
  export type Spawn = typeof import("node:child_process").spawn;
  export function runAction(action: Action, spawnFn?: Spawn, platform?: NodeJS.Platform): Promise<void>;  // rejects with a readable Error
  ```

Decision: `keys` is implemented on Windows by spawning `powershell -NoProfile -Command` with `System.Windows.Forms.SendKeys.SendWait`. No native dependency. On other platforms `runAction` rejects with "keys actions are supported on Windows only in this version". SendKeys cannot press the Windows key or tell left Ctrl from right Ctrl; document it.

- [ ] **Step 1: Failing tests**

```ts
expect(toSendKeys("ctrl+shift+space")).toBe("^+ ");
expect(toSendKeys("alt+f4")).toBe("%{F4}");
expect(toSendKeys("ctrl+a")).toBe("^a");
expect(toSendKeys("enter")).toBe("{ENTER}");
expect(toSendKeys("escape")).toBe("{ESC}");
expect(() => toSendKeys("ctrl+banana")).toThrow(/banana/);
expect(() => toSendKeys("win+r")).toThrow(/win/);
```

With a fake `spawnFn` that records its arguments and returns an `EventEmitter` with `unref()`:

```ts
await runAction({ run: "C:\\app.exe", args: ["--toggle"] }, fake, "win32");
expect(calls[0]).toMatchObject({ cmd: "C:\\app.exe", args: ["--toggle"], opts: { shell: false, detached: true, stdio: "ignore" } });
// Review Focus 4: child emits "error" (ENOENT) => rejects, message contains the program path
await expect(runAction({ run: "C:\\missing.exe" }, failingFake, "win32")).rejects.toThrow(/missing\.exe/);
await expect(runAction({ keys: "ctrl+a" }, fake, "linux")).rejects.toThrow(/Windows only/);
await runAction({ keys: "ctrl+a" }, fake, "win32");
expect(calls.at(-1).cmd).toBe("powershell");
```

- [ ] **Step 2: FAIL. Step 3: Implement.** `run` resolves on the child's `spawn` event, rejects on `error`; call `unref()`. Supported key names: `a-z`, `0-9`, `f1`-`f12`, `space`, `enter`, `escape`, `tab`, `backspace`, `delete`, `up`, `down`, `left`, `right`, `home`, `end`; modifiers `ctrl`, `shift`, `alt`.

- [ ] **Step 4: PASS. Step 5: Commit** `feat: run and keys actions`

---

### Task 7: Models

**Files:**
- Create: `src/models.ts`
- Test: `tests/models.test.ts`

**Interfaces:**
- Consumes: `homeDir`, `Config["model"]`
- Produces:
  ```ts
  export interface ModelFiles { vad: string; encoder: string; mergedDecoder: string; tokens: string }
  export function modelFiles(model: Config["model"], root?: string): ModelFiles;   // root defaults to homeDir()/models
  export function modelsPresent(model: Config["model"], root?: string): boolean;    // all four files exist
  export function downloadModels(model: Config["model"], onProgress: (file: string, done: number, total: number) => void, root?: string): Promise<void>;
  ```

Exact sources (base URL `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/`):

| Item | File | Lands in |
|---|---|---|
| VAD | `silero_vad.onnx` (0.6 MB) | `models/silero_vad.onnx` |
| `moonshine-base-en` | `sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2` (106 MB) | `models/moonshine-base-en/` |
| `moonshine-tiny-en` | `sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2` (28 MB) | `models/moonshine-tiny-en/` |

Each archive has one top folder holding `encoder_model.ort`, `decoder_model_merged.ort`, `tokens.txt`.

- [ ] **Step 1: Failing tests** (temp directory as `root`)

```ts
const f = modelFiles("moonshine-base-en", root);
expect(f.vad).toBe(path.join(root, "silero_vad.onnx"));
expect(f.encoder).toBe(path.join(root, "moonshine-base-en", "encoder_model.ort"));
expect(f.mergedDecoder).toBe(path.join(root, "moonshine-base-en", "decoder_model_merged.ort"));
expect(modelsPresent("moonshine-base-en", root)).toBe(false);
// create the four files empty => true; delete one => false
```

- [ ] **Step 2: FAIL. Step 3: Implement.** Download with global `fetch` (follows redirects) streamed to `<name>.part`, renamed only after the full length arrived. Extract into `<model>.tmp/` by spawning the system `tar` (`tar -xf <archive> --strip-components=1 -C <dir>`; Windows 10+ ships it), then rename the folder to its final name and delete the archive. Skip items already present. Any failure removes `.part` and `.tmp` and rejects (Review Focus 5).

- [ ] **Step 4: PASS.** **Step 5: Manual check:** covered by Task 10's `setup` run. **Step 6: Commit** `feat: model registry and download`

---

### Task 8: Recogniser (native wrapper)

**Files:**
- Create: `src/recognizer.ts`
- Test: `tests/recognizer.int.test.ts`

**Interfaces:**
- Consumes: `ModelFiles`
- Produces:
  ```ts
  export interface Segment { start: number; length: number }             // absolute sample indexes since the first sample
  export interface Segmenter { accept(samples: Float32Array): Segment[] }
  export interface Transcriber { transcribe(samples: Float32Array): string }
  export function createSegmenter(files: ModelFiles): Segmenter;
  export function createTranscriber(files: ModelFiles): Transcriber;
  ```

`npm install sherpa-onnx-node`. API facts verified in the spike (version 2.0.1; its type file is out of date and omits `mergedDecoder`, so cast the config):

```ts
const vad = new sherpa.Vad({ sileroVad: { model, threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.15,
  windowSize: 512, maxSpeechDuration: 8 }, sampleRate: 16000, numThreads: 1, provider: "cpu", debug: 0 }, 60);
vad.acceptWaveform(float32ArrayOfExactly512);  while (!vad.isEmpty()) { const s = vad.front(false); vad.pop(); /* s.start, s.samples */ }

const asr = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { moonshine: { encoder, mergedDecoder }, tokens, numThreads: 2, provider: "cpu", debug: 0 } });
const st = asr.createStream(); st.acceptWaveform({ samples, sampleRate: 16000 }); asr.decode(st); asr.getResult(st).text;
```

- [ ] **Step 1: Integration test** (skipped with `describe.skipIf(!modelsPresent("moonshine-base-en"))`)

Synthetic tones are not speech, so use real audio: read `tests/fixtures/listen.f32` (see Task 9 step 5; skip when absent), feed it in chunks of 700 samples (not a multiple of 512, to test re-chunking). Expect at least one segment, `length > 0`, `start >= 0`, and `normalize(transcribe(clip))` non-empty.

- [ ] **Step 2: Implement.** `createSegmenter` buffers incoming samples and passes exact 512-sample windows to the VAD; a `Float32Array` given to the library must own its buffer (`Float32Array.from`). **Step 3: Run** (`npm test`; passes or is reported as skipped). **Step 4: Commit** `feat: sherpa-onnx wrappers`

---

### Task 9: Pipeline

**Files:**
- Create: `src/pipeline.ts`
- Test: `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `Config`, `Trigger`, `candidatesOf`, `normalize`, `nearest`, `isMatch`, `GroupState`, `Segmenter`, `Transcriber`
- Produces:
  ```ts
  export interface ClipEvent {
    text: string; seconds: number; level: number;                    // level = RMS of the unpadded clip
    nearest: { phrase: string; distance: number } | null;
    outcome: "fired" | "no-match" | "too-long" | "cooldown" | "blocked-by-state";
    trigger: Trigger | null;                                          // set when outcome is fired, cooldown or blocked-by-state
  }
  export interface PipelineOptions { now: () => number; onClip: (e: ClipEvent) => void; onFire: (t: Trigger) => void }
  export class Pipeline {
    constructor(config: Config, segmenter: Segmenter, transcriber: Transcriber, opts: PipelineOptions);
    feed(samples: Float32Array): void;
  }
  ```

Behaviour: keep the most recent 15 s of audio with its absolute start index. For each segment from the segmenter: if `length / 16000 > maxPhraseSeconds`, report `too-long` without transcribing. Otherwise cut `[start - 4800, start + length + 4800]` clamped to the audio held, transcribe, normalise, find nearest. Not a match: `no-match`. Match within `cooldownSeconds` of the last fire: `cooldown`. Match not allowed by `GroupState`: `blocked-by-state`. Otherwise call `onFire`, `apply` state, record fire time, report `fired`. `onFire` is called before `onClip`.

- [ ] **Step 1: Failing tests** with a fake segmenter (returns queued segments on the next `accept`) and a fake transcriber (returns queued strings and records the length of each clip it was given). Config: the two default triggers in group `handy`, defaults otherwise.

```ts
// 1. fires: feed 2 s; segment {start: 16000, length: 12800}; transcriber says "Computer, listen."
//    => onFire called once with triggers[0]; event outcome "fired"; clip length given to transcriber === 12800 + 2 * 4800
// 2. padding clamps at the start of audio: segment {start: 1600, length: 8000} => clip length === 1600 + 8000 + 4800
// 3. too long: segment length 16000 * 3 + 1 => outcome "too-long", transcriber not called
// 4. no match: "start the division" => "no-match", nearest.distance > 2, onFire not called
// 5. state: "computer finish" first => "blocked-by-state"; then "computer listen" => fired; then "computer finish" 2 s later => fired
// 6. cooldown: "computer listen" fires at t=0; "computer finish" at t=1000 ms => "cooldown"; at t=1600 ms => fired
// 7. empty transcription "" => "no-match", nearest null
// 8. level: clip of constant 0.5 => level ≈ 0.5
// 9. long run: feed 60 s in 512-sample chunks, then a segment near the end fires correctly (ring buffer keeps indexes right)
```

- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS.**

- [ ] **Step 5: Real-audio fixture (local only, not committed)**

Ask the author for consent to cut a clip of their own voice; fixtures stay git-ignored either way. Source: `capture-phrases.f32` from the spike, first 30 s, saved as `tests/fixtures/listen.f32`. Add `tests/pipeline.int.test.ts` (skipped when the fixture or models are absent): real segmenter and transcriber, default config, feed the file, expect at least 3 `fired` events for "computer listen" and none for "computer finish".

- [ ] **Step 6: Commit** `feat: detection pipeline`

---

### Task 10: Presets and CLI

**Files:**
- Create: `src/presets.ts`, `src/cli.ts`
- Test: `tests/presets.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `export function preset(name: "default" | "handy", handyPath?: string): unknown` returning a raw config object that `parseConfig` accepts.

- [ ] **Step 1: Failing test**

```ts
const c = parseConfig(preset("handy", "C:\\H\\handy.exe"));
expect(c.triggers.map((t) => [t.phrase, t.group, t.sets])).toEqual([["computer listen", "handy", "on"], ["computer finish", "handy", "off"]]);
expect(c.triggers[0].action).toEqual({ run: "C:\\H\\handy.exe", args: ["--toggle-post-process"] });
expect(c.triggers[0].aliases).toContain("computer listening");
expect(() => parseConfig(preset("default"))).not.toThrow();   // default: same phrases, no group, action { run: "notepad.exe" } as a harmless example
```

- [ ] **Step 2: FAIL, implement, PASS.**

- [ ] **Step 3: Implement `src/cli.ts`** (first line `#!/usr/bin/env node`, argument parsing with `node:util` `parseArgs`, no CLI library)

| Command | Behaviour |
|---|---|
| `init [--preset handy] [--handy-path <exe>]` | Writes `configPath()`. Refuses if it exists (exit 1, message says so). For `handy` without `--handy-path`, writes the placeholder `C:\\path\\to\\handy.exe` and tells the user to edit it. |
| `setup` | `downloadModels` for the configured model (default model when no config). One progress line per file, updated in place. |
| `devices` | Prints `listDevices()`, one per line. |
| `test` | Loads config, checks `modelsPresent` (else: "Models missing. Run: wake-trigger setup", exit 1). Runs the pipeline with `onFire` doing nothing. Per clip prints: seconds, level, `"text"`, nearest phrase and distance, outcome. When level < 0.01 adds "input level is low; raise microphone volume". |
| `start` | Same as `test` but `onFire` calls `runAction`; an action error is printed and listening continues (Review Focus 4). Prints one line per fired trigger with the time. |
| none / `--help` | Usage text. Unknown command: usage, exit 1. |

`ConfigError` prints its message only (no stack) and exits 1. Microphone `onError` prints and exits 1. Ctrl+C stops the mic and exits 0.

- [ ] **Step 4: Manual end-to-end check on Windows**

```
npm run build && npm link
wake-trigger init --preset handy --handy-path "C:\Users\<you>\Applications\Handy\handy.exe"
wake-trigger setup          # expect both downloads to finish; ~/.wake-trigger/models has silero_vad.onnx and moonshine-base-en/
wake-trigger devices        # expect at least one microphone
wake-trigger test           # say "computer listen": expect outcome fired; normal sentence: expect too-long or no-match
wake-trigger start          # with Handy running: "computer listen" starts dictation, "computer finish" stops it
```

Also: rename `~/.wake-trigger/models` and run `wake-trigger start`; expect the "Models missing" message and exit code 1.

- [ ] **Step 5: Commit** `feat: command-line interface and presets`

---

### Task 11: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write it**, in this order: one-paragraph pitch with the origin story from the spec's Intent; a 5-line quick start; how it works (the pipeline diagram from the spec); config reference (every field, both action types, `group`/`sets`); Handy preset including the line to add to Handy's post-processing prompt so the stop phrase is removed from the output (`If the transcript ends with "computer finish", remove that phrase.`); choosing phrases (two-syllable common words, aliases for sound-alikes, use `wake-trigger test`); measured accuracy from the spec's test table, stated as one person's laptop-microphone results; limits (English only, Windows tested, `keys` Windows only without the Windows key, stop phrase stays in raw dictation, state can be wrong for up to `maxOnSeconds` after stopping by keyboard); running at login (shortcut to `wake-trigger start` in the Startup folder); privacy (local only, nothing stored); licence.

- [ ] **Step 2: Check** every command and config field named in the README exists in the code. **Step 3: Commit** `docs: README`

---

## Not in this plan

Publishing to GitHub and npm, and the LinkedIn post. These are outward-facing; do them with the author after the end-to-end check passes.
