import { listDevices, openMic } from "../src/mic";

const device = process.argv[2] ?? "default";

try {
  const devices = listDevices();
  console.log("Devices:");
  devices.forEach((d, i) => console.log(`  [${i}] ${d}`));

  let peak = 0;
  let count = 0;
  let total = 0;
  let second = 0;
  const mic = openMic(
    device,
    (s) => {
      count += s.length;
      total += s.length;
      for (let i = 0; i < s.length; i++) peak = Math.max(peak, Math.abs(s[i]));
    },
    (e) => {
      console.error(`Mic error: ${e.message}`);
      process.exit(1);
    },
  );
  console.log(`Opened "${device}". Capturing 5 seconds...`);

  const timer = setInterval(() => {
    second++;
    console.log(`second ${second}: samples=${count} peak=${peak.toFixed(4)}`);
    peak = 0;
    count = 0;
    if (second >= 5) {
      clearInterval(timer);
      mic.stop();
      console.log(`total samples=${total}`);
    }
  }, 1000);
} catch (e) {
  console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
