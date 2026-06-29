/**
 * Audio output abstraction.
 *
 * The Flywheel emits sound over I2S to a small speaker. The BIOS and Lua deal
 * in simple primitives — tones and raw PCM buffers — and the emulator routes
 * them to the browser's Web Audio output (Phase 1). Phase 0 ships a no-op
 * implementation so the rest of the system can call audio safely.
 *
 * The Phase-0 contract is intentionally minimal: fire-and-forget, no
 * scheduling. Sequencing primitives — completion signals (a done event or
 * promise), a queued-duration / isPlaying query for streaming PCM backpressure,
 * and per-sound handles for targeted stop — arrive with the Web Audio backend
 * in Phase 1, likely via an `events: Emitter<…>` consistent with the other
 * subsystems.
 */
export interface AudioDevice {
  /** Whether sound is currently routed to an output. */
  readonly enabled: boolean;
  setEnabled(enabled: boolean): void;

  /** Play a square/sine tone (Hz) for a duration (ms). */
  playTone(frequencyHz: number, durationMs: number): void;

  /** Queue raw mono PCM samples (-1..1) at the given sample rate. */
  playSamples(samples: Float32Array, sampleRateHz: number): void;

  /** Stop all sound immediately. */
  stop(): void;
}

/** Safe no-op audio device for Phase 0 (and headless tests). */
export class NullAudioDevice implements AudioDevice {
  enabled = false;
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
  playTone(): void {}
  playSamples(): void {}
  stop(): void {}
}
