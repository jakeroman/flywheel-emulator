import type { AudioDevice } from "@flywheel/emulator-core";

/**
 * Routes the emulated I2S audio path to the browser's Web Audio output. Lives
 * in the web package because it depends on the DOM AudioContext; the core stays
 * framework- and DOM-agnostic and only knows the AudioDevice contract.
 *
 * The AudioContext is created lazily and resumed on a user gesture (power-on or
 * the first sound during a user-initiated run) to satisfy autoplay policies.
 */
export class WebAudioDevice implements AudioDevice {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly active = new Set<AudioScheduledSourceNode>();
  private _enabled = true;

  /** Cap concurrent voices so a script spamming tones can't pile up oscillators. */
  private static readonly MAX_VOICES = 12;

  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    if (this.master) this.master.gain.value = enabled ? 1 : 0;
    if (enabled) void this.resume();
  }

  /** Resume a suspended context (call from a user gesture, e.g. power-on). */
  async resume(): Promise<void> {
    const a = this.ensure();
    if (a && a.ctx.state === "suspended") await a.ctx.resume();
  }

  playTone(frequencyHz: number, durationMs: number): void {
    if (!this._enabled) return;
    const a = this.ensure();
    if (!a) return;
    const { ctx, master } = a;
    const now = ctx.currentTime;
    const dur = Math.max(0.01, durationMs / 1000);

    const osc = ctx.createOscillator();
    osc.type = "square"; // small-speaker retro timbre
    osc.frequency.value = frequencyHz;

    // Short attack/release envelope to avoid click artifacts.
    const peak = 0.2;
    const gain = ctx.createGain();
    const fade = Math.min(0.005, dur / 4);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + fade);
    gain.gain.setValueAtTime(peak, now + dur - fade);
    gain.gain.linearRampToValueAtTime(0, now + dur);

    osc.connect(gain).connect(master);
    osc.start(now);
    osc.stop(now + dur);
    this.track(osc);
  }

  playSamples(samples: Float32Array, sampleRateHz: number): void {
    if (!this._enabled || samples.length === 0) return;
    const a = this.ensure();
    if (!a) return;
    const { ctx, master } = a;
    const buffer = ctx.createBuffer(1, samples.length, sampleRateHz);
    buffer.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(master);
    src.start();
    this.track(src);
  }

  stop(): void {
    for (const node of [...this.active]) {
      try {
        node.stop();
      } catch {
        // Already stopped — ignore.
      }
    }
    this.active.clear();
  }

  private ensure(): { ctx: AudioContext; master: GainNode } | null {
    if (typeof AudioContext === "undefined") return null;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this._enabled ? 1 : 0;
      this.master.connect(this.ctx.destination);
    }
    return { ctx: this.ctx, master: this.master! };
  }

  private track(node: AudioScheduledSourceNode): void {
    // Evict the oldest voice if we're at the cap (Set preserves insertion order).
    while (this.active.size >= WebAudioDevice.MAX_VOICES) {
      const oldest = this.active.values().next().value;
      if (!oldest) break;
      this.active.delete(oldest);
      try {
        oldest.stop();
      } catch {
        // Already stopped — ignore.
      }
    }
    this.active.add(node);
    node.addEventListener("ended", () => this.active.delete(node));
  }
}
