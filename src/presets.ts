const PLACEHOLDER_HANDY_PATH = "C:\\path\\to\\handy.exe";

const DEFAULTS = {
  microphone: "default",
  model: "moonshine-base-en",
  tolerance: 2,
  maxPhraseSeconds: 3,
  cooldownSeconds: 1.5,
  maxOnSeconds: 300,
};

export function preset(name: "default" | "handy", handyPath?: string): unknown {
  if (name === "handy") {
    return {
      ...DEFAULTS,
      triggers: [
        {
          phrase: "computer listen",
          aliases: ["computer listening"],
          group: "handy",
          sets: "on",
          action: { run: handyPath ?? PLACEHOLDER_HANDY_PATH, args: ["--toggle-post-process"] },
        },
        {
          phrase: "computer finish",
          aliases: [],
          group: "handy",
          sets: "off",
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
