import { PvRecorder } from "@picovoice/pvrecorder-node";

const FRAME_LENGTH = 512;

export function listDevices(): string[] {
  return PvRecorder.getAvailableDevices();
}

export interface Mic {
  stop(): void;
}

function resolveDeviceIndex(device: string, devices: string[]): number {
  if (device === "default") return -1;
  const exact = devices.indexOf(device);
  if (exact >= 0) return exact;
  const needle = device.toLowerCase();
  const partial = devices.findIndex((d) => d.toLowerCase().includes(needle));
  if (partial >= 0) return partial;
  const available = devices.map((d) => `"${d}"`).join(", ") || "(none)";
  throw new Error(`Unknown microphone "${device}". Available devices: ${available}`);
}

// device: "default" or a device name (exact, else case-insensitive substring).
export function openMic(
  device: string,
  onSamples: (s: Float32Array) => void,
  onError: (e: Error) => void,
): Mic {
  const index = resolveDeviceIndex(device, listDevices());
  const recorder = new PvRecorder(FRAME_LENGTH, index);
  let stopped = false;
  let released = false;

  const release = (): void => {
    if (released) return;
    released = true;
    try {
      recorder.release();
    } catch {
      // already released or never started; nothing to do
    }
  };

  try {
    recorder.start();
  } catch (e) {
    release();
    throw e instanceof Error ? e : new Error(String(e));
  }

  const loop = async (): Promise<void> => {
    try {
      while (!stopped) {
        const frame = await recorder.read();
        if (stopped) break;
        const out = new Float32Array(frame.length);
        for (let i = 0; i < frame.length; i++) out[i] = frame[i] / 32768;
        onSamples(out);
      }
    } catch (e) {
      if (!stopped) {
        stopped = true;
        onError(e instanceof Error ? e : new Error(String(e)));
      }
    } finally {
      release();
    }
  };
  void loop();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        recorder.stop();
      } catch {
        // ignore: the loop releases the recorder when it exits
      }
    },
  };
}
