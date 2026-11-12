# wake-trigger

wake-trigger listens to your microphone and runs an action when it hears a phrase you chose. It works like "Hey Google" or "Hey Siri", but the phrases are plain text in a config file and the action can start any program or press any hotkey. It runs fully on your machine. It needs no account and no API key.

It exists because of Handy, an open-source dictation app (https://github.com/cjpais/Handy). Handy has no wake word; it starts and stops with a keyboard shortcut or a command-line toggle. The author wanted to start and stop dictation by voice while writing outreach messages. Instead of patching one app, wake-trigger works with any app, and it ships with a ready-made Handy preset.

## Quick start

```
git clone https://github.com/<your-username>/wake-trigger.git
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
| `wake-trigger start` | Listens and runs actions. Logs each trigger that fires, and each match that was ignored because of the cooldown or the group state, for example `[12:00:01] ignored "computer finish" (blocked-by-state)`. |
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
| `triggers` | array, not empty | none | The list of triggers. Required. |

### Trigger fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `phrase` | string | yes | The phrase to listen for. Case and punctuation do not matter. |
| `aliases` | array of strings | no | Other spellings that also match. |
| `action` | object | yes | What to do. See below. |
| `group` | string | no | Name of a shared on/off state. Needs `sets`. |
| `sets` | `"on"` or `"off"` | no | Whether this trigger turns its group on or off. Needs `group`. |

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

## Handy preset

Run:

```
wake-trigger init --preset handy --handy-path "C:\path\to\Handy\handy.exe"
```

Without `--handy-path`, the config contains the placeholder `C:\path\to\handy.exe`. Edit `run` in the config to the real path of `handy.exe`.

The preset defines two phrases:

- "computer listen" (alias "computer listening") turns the group `handy` on.
- "computer finish" turns the group `handy` off.

Both run `handy.exe --toggle-post-process`. This Handy flag toggles recording with post-processing. Handy's command line only toggles. It cannot tell wake-trigger whether it is recording. That is why the preset uses a group.

While Handy records, it also hears you say "computer finish", so the phrase ends up in the text. Add this line to Handy's post-processing prompt to remove it:

```
If the transcript ends with "computer finish", remove that phrase.
```

In raw mode, without post-processing, the phrase stays in the text. This is a known limit.

## Choosing phrases

Run `wake-trigger test` and say your candidate phrases. For every clip it prints the length, the input level, the text it heard, the nearest phrase with its distance, and the outcome:

```
1.2s  level 0.045  "computer listen"  nearest "computer listen" (0)  -> fired
```

The outcome is one of `fired`, `no-match`, `too-long`, `cooldown` or `blocked-by-state`. In `test` mode no action runs, so `fired` means "would fire".

What works, from testing:

- Use two-syllable common words. "Listen" and "finish" work. One-syllable words such as "stop" and "done" failed.
- Avoid very short, one-word phrases. They are easy to trigger by accident and easy to mishear.
- Use common words. Rare words are heard as common ones. "Handy" was misheard.
- Add aliases for sound-alikes. If the program hears "right" for "write", add the heard spelling to `aliases`.
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
- If you stop the app by keyboard, wake-trigger does not know. Its state stays wrong for up to `maxOnSeconds`. In that time the next start phrase is ignored.
- Phrases are fixed triggers. There are no voice commands with parameters.
- There is no graphical interface and no tray icon.

## Running at login

Autostart is not automated. To do it by hand on Windows:

1. Press Win+R, type `shell:startup`, and press Enter. The Startup folder opens.
2. Create a shortcut in that folder. Set its target to `cmd.exe /k wake-trigger start`.

This uses `wake-trigger` from your PATH, so run `npm link` first. A console window stays open while it runs, and `/k` keeps it open if an error stops the program at login. Close it to stop wake-trigger. This setup has not been tested.

## Privacy

- Audio is processed in memory on your machine. No audio is written to disk.
- No audio and no text leave your machine.
- The only network use is `wake-trigger setup`, which downloads the models from the k2-fsa/sherpa-onnx GitHub releases.
- The program logs the time and phrase of each trigger to the console. It stores nothing else.

## Licence

MIT. See `LICENSE`.
