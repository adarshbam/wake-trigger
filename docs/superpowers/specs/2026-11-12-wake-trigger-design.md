# wake-trigger: design

Date: 2026-11-12
Status: draft, waiting for approval

## Intent

A small background program that listens to the microphone and runs an action when it hears a spoken phrase, the way "Hey Google" or "Hey Siri" work. Each phrase maps to an action: run a command or press a hotkey. Any installed app can be triggered this way.

The reason it exists: Handy (an open-source dictation app) only starts and stops with a keyboard shortcut. The author wanted to start and stop dictation by voice while writing outreach messages. Handy has no wake word (a draft pull request, cjpais/Handy#1469, is unmerged). Rather than patch one app, this tool works for any app, and ships with a ready-made Handy preset.

It is also a public portfolio project: published on GitHub, written about on LinkedIn. It must be easy for a stranger to install, understand, and trust.

## Goals

- Say a start phrase and a stop phrase; the mapped actions run within about one second.
- Phrases are plain text in a config file. No model training, no account, no API key.
- Works for any app through two action types: run a command, press a hotkey.
- Handy works out of the box through a preset.
- Fully local. No audio leaves the machine. Nothing is recorded to disk.
- Node.js and TypeScript, installable with npm.
- Honest documentation of accuracy and limits.

## Non-goals (version 1)

- No graphical interface, tray icon, or installer.
- No languages other than English.
- No custom-trained wake-word models.
- No guarantee on macOS or Linux. The code must not block them, but only Windows 11 is tested.
- No voice commands with parameters ("open file X"). A phrase is a fixed trigger.

## Anti-goals

- Triggering during normal conversation. A false trigger that starts dictation or runs a command unasked is worse than a missed phrase.
- Requiring a paid or closed-source engine, or a per-user key.
- Sending audio or text to any server.
- Claiming Siri-level accuracy. The README states measured numbers.

## Constraints

- Free and open-source dependencies only.
- Windows paths longer than 260 characters break the speech library's file loading. Models must live in a short path.
- The program must run as a normal user process started by the user (terminal or Windows startup), not from inside a sandboxed app.
- Handy's command line only toggles (`--toggle-transcription`, `--toggle-post-process`, `--cancel`). It cannot report whether it is recording.

## Approaches considered

All four were considered; the first two were tested on the author's voice and laptop microphone.

1. **Keyword-spotting model (sherpa-onnx KWS, 3.3M parameters).** Purpose-built, tiny, open vocabulary. Tested: "hey handy" 0 of 5, "stop handy" 2 of 5. A sweep of 54 settings (thresholds, boost scores, gain, tokenisations) reached at best 1 of 5 and 2 of 5. Rejected on evidence.
2. **Voice-activity detector plus small speech recogniser plus fuzzy text match.** Silero VAD cuts speech into clips; a Moonshine model transcribes each short clip; the text is compared with the configured phrases. Tested: with the base model, "computer listen" 5 of 5, "computer finish" 4 of 5, no false triggers in normal talk. **Chosen.** Phrases stay plain text, and the user can see exactly what the program heard, which makes it debuggable.
3. **openWakeWord.** Good accuracy, but every new phrase needs a training run. Rejected: users must be able to type a phrase and go.
4. **Picovoice Porcupine.** Accurate, but closed source and needs a per-user access key. Rejected by the author.

### What the tests taught (carry into the build)

| Finding | Consequence |
|---|---|
| Tiny Moonshine model (27 MB) gave inconsistent results between runs; base model (106 MB) was clearly better | Default model is base. Tiny is optional. |
| Adding 0.3 s of audio before and after each clip raised accuracy a lot | Keep a rolling pre-buffer; pad every clip. |
| Two-syllable command words ("listen", "finish") work; one-syllable words ("stop", "done") fail | Default phrases and README guidance follow this. |
| Sound-alike spellings ("write" heard as "right") | Each phrase supports aliases. |
| Rare words ("handy") are misheard as common ones | Guidance: use common words. |
| Matching the whole short utterance, not a substring of long speech, gave zero false triggers | Only clips up to about 3 seconds are transcribed and matched. |
| Quiet microphone lowered every score | `test` command shows input level and warns when low. |
| Base model: about 100 ms per clip after load | Fast enough on a laptop CPU. |

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

### Matching

A clip matches a phrase when the normalised text is within `tolerance` character edits of the phrase or one of its aliases (default tolerance 2), or starts with the phrase followed by at most a few extra letters ("computer listening"). The closest phrase wins. Ties do nothing.

### Actions

- `run`: start a program with arguments. Does not wait for it to exit. No shell, so config values are never interpreted as shell syntax.
- `keys`: press a key combination, for apps with no command line.

### Toggle state

Apps like Handy only toggle. If the stop phrase fired while idle, it would start dictation instead. Triggers can therefore share a named `group` and declare `sets: "on"` or `sets: "off"`. A trigger with `sets: "on"` fires only when its group is off, and the reverse. A group returns to off after `maxOnSeconds` (default 300) so a missed stop phrase cannot leave the state wrong forever. Triggers without a group always fire.

Known limit: if the user stops the app by keyboard, the tool's state is wrong until the timeout. In that window the next start phrase is ignored. See open question 1.

### Config

One JSON file at `~/.wake-trigger/config.json`. Example (the Handy preset):

```json
{
  "microphone": "default",
  "model": "moonshine-base-en",
  "tolerance": 2,
  "maxPhraseSeconds": 3,
  "cooldownSeconds": 1.5,
  "triggers": [
    {
      "phrase": "computer listen",
      "aliases": ["computer listening"],
      "group": "handy",
      "sets": "on",
      "action": { "run": "C:\\Users\\<you>\\Applications\\Handy\\handy.exe", "args": ["--toggle-post-process"] }
    },
    {
      "phrase": "computer finish",
      "aliases": [],
      "group": "handy",
      "sets": "off",
      "action": { "run": "C:\\Users\\<you>\\Applications\\Handy\\handy.exe", "args": ["--toggle-post-process"] }
    }
  ]
}
```

Invalid config stops the program at start with a message that names the field.

### Commands

| Command | What it does |
|---|---|
| `wake-trigger init [--preset handy]` | Writes a starter config. Never overwrites an existing one. |
| `wake-trigger setup` | Downloads the voice-activity and speech models into `~/.wake-trigger/models`. |
| `wake-trigger devices` | Lists microphones. |
| `wake-trigger test` | Listens and prints, for every clip: input level, the text heard, the nearest phrase and its distance. Runs no actions. This is how a user picks phrases that work for their voice. |
| `wake-trigger start` | Listens and runs actions. Logs each trigger. |

Running at login is documented (Windows Startup folder shortcut), not automated.

### Models

Not bundled in the npm package. `setup` downloads them from the official `k2-fsa/sherpa-onnx` GitHub releases: `silero_vad.onnx` (0.6 MB) and the Moonshine base English model (106 MB). `start` and `test` say so clearly when models are missing.

### The stop phrase inside dictation

While Handy records, the stop phrase is also dictated. The Handy preset documentation gives one line to add to Handy's post-processing prompt so the phrase is removed from the output. In raw (non-post-processed) mode the phrase stays in the text; this is a documented limit.

## Decisions made by the author

- Node.js and TypeScript.
- Start and stop phrases.
- Generic: any app, through run-command or press-hotkey, with Handy as a preset.
- Open source, free, published on GitHub.
- Engine: approach 2, after seeing the test results.
- Default phrases: "computer listen" and "computer finish".

## Calls made by the designer (change any of these)

- Name: `wake-trigger`.
- Licence: MIT.
- Config is a JSON file in the home directory; models next to it.
- Command-line only; no tray icon; autostart documented, not automated.
- English only in version 1.
- The `test` command is part of the product.
- Group/sets state model with a timeout.
- `run` actions use no shell.
- Windows 11 is the only tested platform in version 1.

## Left to the builder

- Microphone capture library. The spike used `ffmpeg`, which is not acceptable as a required dependency. Requirement: installs through npm with a prebuilt Windows binary, delivers 16 kHz mono float samples, lets the user choose a device. Prove this with a small spike first; it is the main technical risk.
- Hotkey library for `keys` actions, same requirement (npm, prebuilt for Windows). If none is reliable, `keys` may ship after `run`; say so before cutting it.
- Command-line parsing, logging format, download progress display.
- Test approach: the matcher, text normalisation, state machine, and config validation are pure functions and get unit tests. The pipeline gets one test that replays a recorded audio file and asserts the trigger sequence.

## Changes after first live use (2026-11-12)

Live use with Handy exposed three failures. Each has a fix in the tool.

| Failure seen | Cause | Fix |
|---|---|---|
| Dictation opened and closed within a second | Two copies of `start` were running; both fired, so Handy got two toggles | `start` takes a lock file (`start.lock` in the home folder, holding the process id). A second copy stops with "already running". A lock left by a killed copy is detected by its dead process id. |
| "computer listen" only opened the Handy window | Handy was closed; a toggle sent to a closed app just launches it, and the tool's state went wrong | Triggers accept `requires` (a process name). The trigger is skipped, with a message, while that process is not running. The Handy preset sets `requires: "handy.exe"`. |
| Stop phrase ignored with no way out | The tool's on/off memory was wrong and a state-blocked phrase was always ignored | Repeating a state-blocked phrase within `forceRepeatSeconds` (default 10) fires it anyway. This resolves the open question below: ignore the first time, fire on a deliberate repeat. |

A fourth change followed. Skipping phrases while the app is closed was safe but left the user to open the app by hand, and the app had closed without notice. Triggers now accept `launch`: when the `requires` process is not running, the tool starts that program, waits for the process to appear, waits `launchWaitSeconds` (default 5), then sends the action. Measured with Handy: closed to recording in about 7 seconds.

A fifth change: the stop phrase often needed many attempts. Cause, reproduced on recorded audio: without a pause of about half a second before the phrase, the voice-activity detector joined it to the dictated sentence, the clip exceeded `maxPhraseSeconds`, and it was skipped. Long clips now have their last `maxPhraseSeconds` transcribed and their last words compared with the phrases (`matchAtEnd`, default on). On the same audio a 0.1 s pause now fires; normal long speech still does not.

A sixth change replaced guessing with knowing. Remembering what was sent kept going wrong: a second copy, a closed app, a keyboard stop, and finally the speaker repeating the phrase while the app was starting, which forced it off again. Handy cannot be asked for its state, but it logs every start and stop. Groups can now be watched: the tool follows the app's log file with two regular expressions and treats what it sent only as an expectation that lasts `confirmSeconds`. Repeats are then harmless in both directions, and a command that did not take effect is sent again on the next repeat.

A seventh finding came from the dictation app's own saved recordings, replayed through the pipeline. During real dictation the small speech model heard the stop phrase correctly only about one time in five: "computer finish" came out as "competitive finish", "combido finish", "some bit of finish", "computer Swedish". The large model in the dictation app heard every one. Making the audio louder changed nothing. Two things follow. Aliases taken from a user's own recordings matter far more than first assumed, and a short clip that ends with the phrase (the phrase said twice in a hurry) now matches. The recogniser itself is the limit; a stronger model is the open item.

An eighth change followed from that finding. A second speech model, NVIDIA Parakeet TDT-CTC 110M (same size, same speed), was compared with Moonshine base on the same recordings through the real pipeline, with only the plain phrases configured. Slow, deliberate phrases: 14 fired for each. Twenty-two stop attempts at the end of four real dictations: 8 fired against 3, and the first attempt was caught in 2 of 4 dictations against 0 of 4. Parakeet is now the default and Moonshine stays selectable. Parakeet still mishears this speaker ("a bit of finish"), so `start` can log near misses, clips that matched nothing but ended with almost the last word of a phrase, to show which aliases to add.

## Open questions (resolved)


1. When the stop phrase is heard while the group is off, should the tool ignore it (current design) or fire anyway? Ignoring is safer; firing lets the user recover from a wrong state by voice.
