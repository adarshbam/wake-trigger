# wake-trigger

wake-trigger listens to your microphone and runs an action when it hears a phrase you chose. It works like "Hey Google" or "Hey Siri", but the phrases are plain text in a config file and the action can start any program or press any hotkey. It runs fully on your machine. It needs no account and no API key.

It exists because of Handy, an open-source dictation app (https://github.com/cjpais/Handy). Handy has no wake word; it starts and stops with a keyboard shortcut or a command-line toggle. The author wanted to start and stop dictation by voice while writing outreach messages. Instead of patching one app, wake-trigger works with any app, and it ships with a ready-made Handy preset.

```
you:    "computer listen"
        -> dictation starts
you:    (dictate a message)
you:    "computer finish"
        -> dictation stops, the cleaned text is pasted
```

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Config reference](#config-reference)
- [Handy preset](#handy-preset)
- [Choosing phrases](#choosing-phrases)
- [Measured accuracy](#measured-accuracy)
- [Limits](#limits)
- [Running at login](#running-at-login)
- [Privacy](#privacy)
- [Development](#development)

## Quick start

```
git clone https://github.com/adarshbam/wake-trigger.git
cd wake-trigger
npm install && npm run build && npm link
wake-trigger init && wake-trigger setup && wake-trigger test
```

`npm link` puts the `wake-trigger` command on your PATH. Without it, run `node dist/cli.js` instead of `wake-trigger`.

The package is not on npm yet, so you install from source.

Then:

1. `wake-trigger init` writes a starter config to `~/.wake-trigger/config.json`. The default config opens Notepad on "computer listen" and "computer finish". Use `wake-trigger init --preset handy` for the Handy preset.
2. `wake-trigger setup` downloads the speech models (about 110 MB).
3. `wake-trigger test` shows what the program hears. It runs no actions.
4. `wake-trigger start` listens and runs actions. Press Ctrl+C to stop.

### Requirements

- Node.js 20 or newer.
- Windows 10 or 11. Tested on Windows 11 only.
- A microphone.
- About 110 MB of disk space for the models.
- The `tar` command, which is built into Windows 10 and later. `setup` uses it to unpack the models.

macOS and Linux are untested. The code does not block them, but `keys` actions work on Windows only.

### Commands

| Command | What it does |
|---|---|
| `wake-trigger init [--preset default\|handy] [--handy-path <exe>]` | Writes a starter config. Never overwrites an existing config. |
| `wake-trigger setup` | Downloads the voice-activity model and the speech model into `~/.wake-trigger/models`. |
| `wake-trigger devices` | Lists microphones. |
| `wake-trigger test` | Listens and prints one line per clip. Runs no actions. |
| `wake-trigger start` | Listens and runs actions. Logs each trigger that fires, each match that was ignored because of the cooldown or the group state, and each match skipped because its required program is not running. Only one copy can run at a time; a second `start` stops with `wake-trigger is already running`. |
| `wake-trigger stop` | Stops the running copy. |
| `wake-trigger status` | Shows whether a copy is running and whether it starts at sign-in. |
| `wake-trigger autostart enable` / `disable` | Starts it hidden at every Windows sign-in, or stops doing so. See "Running at login". |
| `wake-trigger --help` | Shows the usage text. |

`start` and `test` print `Models missing. Run: wake-trigger setup` when the models are not there.

## How it works

```
microphone (16 kHz mono)
  -> voice-activity detector: emits one clip per utterance
  -> skip clips longer than maxPhraseSeconds (normal talk)
  -> pad clip with 0.3 s before and after
  -> speech recogniser: clip -> text
  -> normalise text (lower case, letters and spaces only)
  -> matcher: compare with every phrase and alias
  -> state check: is this trigger allowed right now?
  -> action: run command or press hotkey
  -> cooldown
```

A voice-activity detector (Silero VAD) cuts the audio into one clip per utterance. A small speech model (Moonshine) turns each short clip into text. The text is compared with your phrases.

Only short clips are transcribed. A clip longer than `maxPhraseSeconds` is normal conversation and is skipped. This is what keeps false triggers rare.

A clip matches a phrase when its text is within `tolerance` character edits of the phrase or one of its aliases. It also matches when it starts with the phrase and has at most three extra characters (spaces count), as in "computer listening". The closest phrase wins. If two different triggers tie, nothing happens.

Two config checks run at start. A phrase must contain at least one letter. Two triggers whose phrases are within `tolerance` edits of each other are rejected, because they could not be told apart.

wake-trigger uses these libraries:

- `sherpa-onnx-node`, from the k2-fsa/sherpa-onnx project. It runs the Silero VAD and Moonshine models.
- `@picovoice/pvrecorder-node` for microphone capture. It is Apache-2.0 and needs no access key.

## Config reference

The config is one JSON file at `~/.wake-trigger/config.json`. Set the environment variable `WAKE_TRIGGER_HOME` to use another directory. The config file and the `models` folder then live there.

If the config is invalid, the program stops at start with a message that names the field. A field name that is not listed below (for example a typo such as `tolernace`) is an error, and so is an invalid `keys` string. If you change `model`, run `wake-trigger setup` again to download the new model.

### Top-level fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `microphone` | string | `"default"` | `"default"` or a device name from `wake-trigger devices`. An exact name wins. Otherwise a case-insensitive part of the name matches. |
| `model` | string | `"moonshine-base-en"` | `"moonshine-base-en"` (106 MB, more accurate) or `"moonshine-tiny-en"` (27 MB, less consistent). |
| `tolerance` | number, 0 or more | `2` | Largest number of character edits between the heard text and a phrase that still counts as a match. |
| `maxPhraseSeconds` | number, above 0 | `3` | Clips longer than this are skipped. |
| `cooldownSeconds` | number, 0 or more | `1.5` | After a trigger fires, any match within this time is ignored. |
| `maxOnSeconds` | number, above 0 | `300` | A group that was turned on returns to off after this many seconds. |
| `forceRepeatSeconds` | number, 0 or more | `10` | A phrase ignored because of group state fires anyway when it is said again within this time. `0` turns this off. |
| `triggers` | array, not empty | none | The list of triggers. Required. |

### Trigger fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `phrase` | string | yes | The phrase to listen for. Case and punctuation do not matter. |
| `aliases` | array of strings | no | Other spellings that also match. |
| `action` | object | yes | What to do. See below. |
| `group` | string | no | Name of a shared on/off state. Needs `sets`. |
| `sets` | `"on"` or `"off"` | no | Whether this trigger turns its group on or off. Needs `group`. |
| `requires` | string | no | Name of a process, for example `"handy.exe"`. The trigger is skipped while that process is not running. |

### Actions

An action has exactly one of `run` or `keys`.

| Field | Type | Meaning |
|---|---|---|
| `run` | string | Path or name of a program to start. wake-trigger does not wait for it to exit. |
| `args` | array of strings | Arguments for `run`. Optional. |
| `keys` | string | A key combination to press, such as `"ctrl+shift+space"`. |

`run` starts the program directly, without a shell. Config values are never read as shell syntax. This has two effects:

- `.bat` and `.cmd` files do not work as `run` targets, and shell syntax such as `&&`, pipes and `%VARIABLES%` does not work.
- To run a batch file, point `run` at `cmd.exe` and pass the file as an argument:

```json
{ "run": "cmd.exe", "args": ["/c", "your.bat"] }
```

`keys` is a list of modifiers and one key, joined with `+`. Case does not matter.

- Modifiers: `ctrl`, `shift`, `alt`.
- Keys: a single letter `a` to `z`, a single digit `0` to `9`, `f1` to `f12`, `enter`, `escape`, `tab`, `backspace`, `delete`, `up`, `down`, `left`, `right`, `home`, `end`, `space`.

`keys` runs on Windows only. It uses PowerShell and `SendKeys`. It cannot press the Windows key, and it cannot tell the left Ctrl, Shift or Alt from the right one.

### Groups and `sets`

Some apps only toggle. Handy has one command that starts recording and the same command stops it. If your stop phrase fired while the app was idle, it would start recording.

Triggers that share a `group` solve this. A trigger with `sets: "on"` fires only when its group is off. A trigger with `sets: "off"` fires only when its group is on. A stop phrase heard while the group is off is ignored. Triggers without a group always fire.

A group returns to off after `maxOnSeconds`, so a missed stop phrase cannot leave the state wrong for ever.

wake-trigger cannot see the real state of the app. It only remembers what it sent. If you start or stop the app another way, that memory is wrong, and the next phrase is ignored:

```
[12:00:01] ignored "computer finish" (blocked-by-state; say it again to force)
```

Say the same phrase again within `forceRepeatSeconds` and it fires anyway:

```
[12:00:05] fired "computer finish" (forced by repeat)
```

### `requires`

A toggle command sent to an app that is closed usually just opens the app, and the state goes wrong. Give the trigger `"requires": "handy.exe"` and it is skipped while that program is not running:

```
[12:00:01] skipped "computer listen" (handy.exe is not running)
```

The process list is refreshed every 2 seconds. On Windows the name is the image name shown by `tasklist`.

## Handy preset

Run:

```
wake-trigger init --preset handy --handy-path "C:\path\to\Handy\handy.exe"
```

Without `--handy-path`, the config contains the placeholder `C:\path\to\handy.exe`. Edit `run` in the config to the real path of `handy.exe`.

The preset defines two phrases:

- "computer listen" (alias "computer listening") turns the group `handy` on.
- "computer finish" turns the group `handy` off.

Both run `handy.exe --toggle-post-process`. This Handy flag toggles recording with post-processing. Handy's command line only toggles. It cannot tell wake-trigger whether it is recording. That is why the preset uses a group. Both triggers also set `requires: "handy.exe"`, so nothing is sent while Handy is closed. Start Handy first.

While Handy records, it also hears you say "computer finish", so the phrase ends up in the text. Add this to Handy's post-processing prompt (Settings, Post Process) to remove it. List the phrases and aliases from your own config:

```
If the transcript ends with one or more spoken stop commands, remove them from the output; they are a voice command, not dictation. Stop commands are: "computer finish", "computer finished", "computer stop", and close mishearings of these at the very end of the transcript. Do the same for a start command at the very beginning ("computer listen", "computer listening").
```

In raw mode, without post-processing, the phrase stays in the text. This is a known limit.

## Choosing phrases

Run `wake-trigger test` and say your candidate phrases. For every clip it prints the length, the input level, the text it heard, the nearest phrase with its distance, and the outcome:

```
1.2s  level 0.045  "computer listen"  nearest "computer listen" (0)  -> fired
```

The outcome is one of `fired`, `no-match`, `too-long`, `cooldown`, `blocked-by-state` or `not-running`. In `test` mode no action runs, so `fired` means "would fire".

What works, from testing:

- Use two-syllable common words. "Listen" and "finish" work. One-syllable words such as "stop" and "done" failed.
- Avoid very short, one-word phrases. They are easy to trigger by accident and easy to mishear.
- Use common words. Rare words are heard as common ones. "Handy" was misheard.
- Add aliases for sound-alikes. If the program hears "right" for "write", add the heard spelling to `aliases`.
- Add aliases for what `test` hears from you. A speech model mishears each voice in its own way. The author's config lists "come to listen" and "combator finish", because that is what the model printed for some attempts. Ten aliases per phrase is normal.
- Raise the microphone volume if `test` prints `(input level is low; raise microphone volume)`. A quiet microphone lowers every score.
- Say the phrase on its own. Clips longer than `maxPhraseSeconds` are skipped.

## Measured accuracy

These are the results of one speaker, the author, on one laptop microphone. They are small samples and not a benchmark. Your results will differ.

| Method | Phrase | Result |
|---|---|---|
| sherpa-onnx keyword spotter | "hey handy" | 0 of 5 |
| sherpa-onnx keyword spotter | "stop handy" | 2 of 5 |
| Voice-activity detector, Moonshine base, text match (the method used) | "computer listen" | 5 of 5 |
| Voice-activity detector, Moonshine base, text match (the method used) | "computer finish" | 4 of 5 |

The keyword spotter did not improve in a sweep of 54 settings. The best it reached was 1 of 5 and 2 of 5. It was dropped.

With the chosen method there were no false triggers in normal talk. The tiny Moonshine model (27 MB) gave inconsistent results between runs, so the base model is the default. Adding 0.3 s of audio before and after each clip raised accuracy a lot. The base model takes about 100 ms per clip on a laptop CPU.

wake-trigger is not as accurate as the wake word on a phone. If a phrase is missed, say it again.

## Limits

- English only.
- Only Windows 11 is tested. macOS and Linux are untested.
- `keys` works on Windows only and cannot press the Windows key.
- The stop phrase stays in the text in raw dictation. The post-processing prompt line above removes it.
- If you stop the app by keyboard, wake-trigger does not know. Its state stays wrong for up to `maxOnSeconds`. In that time the next start phrase is ignored once; say it again to force it.
- Handy must already be running. The first recording right after Handy launches can misfire.
- Phrases are fixed triggers. There are no voice commands with parameters.
- There is no graphical interface and no tray icon.
- Unplugging the microphone while the program runs is untested. The program is written to stop with `Microphone error`, but this was not checked on hardware.

## Running at login

```
wake-trigger autostart enable
```

This writes a small script, `wake-trigger.vbs`, into your Windows Startup folder. At each sign-in it starts `wake-trigger start` with no window. It uses the exact `node` and the exact build that ran the command, so `npm link` is not needed.

A hidden program has no console, so its output goes to `~/.wake-trigger/wake-trigger.log`. Look there if a phrase does nothing.

| Command | What it does |
|---|---|
| `wake-trigger autostart enable` | Start hidden at every sign-in. Does not start it now. |
| `wake-trigger autostart disable` | Remove the Startup script. A copy running now keeps running. |
| `wake-trigger status` | Shows whether a copy is running, and whether autostart is on. |
| `wake-trigger stop` | Stops the running copy, hidden or not. |

To start it hidden right away without signing out, double-click `wake-trigger.vbs` in the Startup folder (Win+R, `shell:startup`).

Limits: Windows only. If the microphone is not ready at sign-in, the program stops and the log says why; start it again with the script. If you move the project folder or change your Node.js install, run `autostart enable` again.

## Privacy

- Audio is processed in memory on your machine. No audio is written to disk.
- No audio and no text leave your machine.
- The only network use is `wake-trigger setup`, which downloads the models from the k2-fsa/sherpa-onnx GitHub releases.
- The program logs the time and phrase of each trigger to the console, or to `~/.wake-trigger/wake-trigger.log` when it was started at sign-in. It stores nothing else. Speech that matches no phrase is not logged.

## Development

```
npm install
npm test          # unit tests; two integration tests run only when the models and a local audio fixture exist
npm run build     # compiles src/ to dist/
npm run dev -- test
```

| File | Responsibility |
|---|---|
| `src/cli.ts` | Commands. |
| `src/mic.ts` | Microphone capture. |
| `src/recognizer.ts` | The only file that touches the native speech library. |
| `src/pipeline.ts` | Clip handling: pad, length gate, transcribe, match, state, cooldown. |
| `src/matcher.ts`, `src/normalize.ts` | Fuzzy phrase matching. |
| `src/state.ts` | Group on/off memory. |
| `src/actions.ts` | Run a program, press a hotkey. |
| `src/config.ts`, `src/presets.ts` | Config validation and starter configs. |
| `src/models.ts` | Model download. |
| `src/lock.ts`, `src/processes.ts`, `src/autostart.ts` | Single running copy, process check, start at sign-in. |

The pipeline depends on two small interfaces, `Segmenter` and `Transcriber`, so its logic is tested with fakes and no microphone.

The design document, with the approaches that were tried and rejected and the measurements behind each decision, is in [`docs/superpowers/specs`](docs/superpowers/specs/2026-11-12-wake-trigger-design.md).

### Ideas not built yet

- Tray icon with on/off state.
- macOS and Linux testing; `keys` actions outside Windows.
- Other languages (the Moonshine models used here are English only).
- A published npm package.
- An opt-in way to save missed clips, to tune aliases faster.

Issues and pull requests are welcome.

## Acknowledgements

- [Handy](https://github.com/cjpais/Handy), the dictation app this was built around.
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), Silero VAD and Moonshine, for local speech recognition.
- [pvrecorder](https://github.com/Picovoice/pvrecorder) for microphone capture.

## Licence

MIT. See `LICENSE`.
