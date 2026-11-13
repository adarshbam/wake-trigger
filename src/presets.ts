import * as path from "node:path";

const PLACEHOLDER_HANDY_PATH = "C:\\path\\to\\handy.exe";

const DEFAULTS = {
  microphone: "default",
  model: "moonshine-base-en",
  tolerance: 2,
  maxPhraseSeconds: 3,
  cooldownSeconds: 1.5,
  maxOnSeconds: 300,
  forceRepeatSeconds: 10,
  launchWaitSeconds: 5,
  matchAtEnd: true,
  sounds: false,
};

/** Lines Handy writes to its log (at log level Debug) when dictation starts and ends. */
export const HANDY_ON_PATTERN = "TranscribeAction::start called";
export const HANDY_OFF_PATTERN = "TranscribeAction::stop called|Initiating operation cancellation|recording stopped after";

export function preset(
  name: "default" | "handy",
  handyPath?: string,
  localAppData: string | undefined = process.env.LOCALAPPDATA,
): unknown {
  if (name === "handy") {
    // Handy cannot be asked whether it is recording, but it logs every start and stop.
    const groups = localAppData
      ? { handy: { watchFile: path.join(localAppData, "com.pais.handy", "logs", "handy.log"), onPattern: HANDY_ON_PATTERN, offPattern: HANDY_OFF_PATTERN } }
      : {};
    return {
      ...DEFAULTS,
      groups,
      triggers: [
        {
          phrase: "computer listen",
          aliases: ["computer listening"],
          group: "handy",
          sets: "on",
          requires: "handy.exe",
          launch: { run: handyPath ?? PLACEHOLDER_HANDY_PATH, args: ["--start-hidden"] },
          action: { run: handyPath ?? PLACEHOLDER_HANDY_PATH, args: ["--toggle-post-process"] },
        },
        {
          phrase: "computer finish",
          aliases: [],
          group: "handy",
          sets: "off",
          requires: "handy.exe",
          action: { run: handyPath ?? PLACEHOLDER_HANDY_PATH, args: ["--toggle-post-process"] },
        },
      ],
    };
  }
  return {
    ...DEFAULTS,
    triggers: [
      { phrase: "computer listen", aliases: ["computer listening"], action: { run: "notepad.exe" } },
      { phrase: "computer finish", aliases: [], action: { run: "notepad.exe" } },
    ],
  };
}
