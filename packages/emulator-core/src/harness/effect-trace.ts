/**
 * HAL effect recording for the faithfulness harness.
 *
 * A module's entire *observable* contract is the ordered stream of effects it
 * drives through the HAL: pixels on the display, tones, SD writes, log lines.
 * Recording that stream gives a backend-agnostic trace — the same harness can
 * validate the wasm32 backend now and, later, diff the Xtensa interpreter
 * against it (differential testing). The display is captured as a CRC-32 of its
 * packed framebuffer (reusing the .fwmod crc32) so a full frame is one cheap,
 * comparable number.
 */

import { crc32 } from "../fwmod/crc32.js";
import type { AudioDevice } from "../hal/audio.js";
import type { DisplayDevice } from "../hal/display.js";
import type { SDCard } from "../hal/sd.js";

export type HalEvent =
  | { kind: "frame"; crc32: number }
  | { kind: "tone"; hz: number; ms: number }
  | { kind: "samples"; length: number; rateHz: number; crc32: number }
  | { kind: "fsChange"; path: string }
  | { kind: "log"; message: string };

/** Collects an ordered HAL effect trace. Wire it to a device's audio + SD, feed
 *  it log lines, and snapshot the display once per frame. */
export class HalEffectRecorder {
  readonly events: HalEvent[] = [];
  private offSd: (() => void) | null = null;

  /** Append an event (also the sink RecordingAudioDevice writes to). */
  readonly push = (event: HalEvent): void => {
    this.events.push(event);
  };

  /** Record SD mutations from this card until detach(). */
  attachSd(sd: SDCard): void {
    this.offSd?.();
    this.offSd = sd.events.on("change", ({ path }) =>
      this.push({ kind: "fsChange", path }),
    );
  }

  /** Snapshot the current framebuffer as a frame event. Call once per frame. */
  frame(display: DisplayDevice): void {
    this.push({ kind: "frame", crc32: crc32(display.getPackedBuffer()) });
  }

  log(message: string): void {
    this.push({ kind: "log", message });
  }

  reset(): void {
    this.events.length = 0;
  }

  detach(): void {
    this.offSd?.();
    this.offSd = null;
  }
}

/**
 * An AudioDevice that records tone/sample calls into a sink, then delegates to a
 * wrapped device. Construct the emulated device with one of these
 * (`new EmulatedFlywheelDevice({ audio: new RecordingAudioDevice(...) })`) to
 * capture audio effects in the trace.
 */
export class RecordingAudioDevice implements AudioDevice {
  constructor(
    private readonly sink: (event: HalEvent) => void,
    private readonly inner: AudioDevice,
  ) {}

  get enabled(): boolean {
    return this.inner.enabled;
  }
  setEnabled(enabled: boolean): void {
    this.inner.setEnabled(enabled);
  }
  playTone(frequencyHz: number, durationMs: number): void {
    this.sink({ kind: "tone", hz: frequencyHz, ms: durationMs });
    this.inner.playTone(frequencyHz, durationMs);
  }
  playSamples(samples: Float32Array, sampleRateHz: number): void {
    // Hash the content (like a frame) so distinct buffers are distinguishable.
    this.sink({
      kind: "samples",
      length: samples.length,
      rateHz: sampleRateHz,
      crc32: crc32(
        new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
      ),
    });
    this.inner.playSamples(samples, sampleRateHz);
  }
  stop(): void {
    this.inner.stop();
  }
}
