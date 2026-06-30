/**
 * Loading + inspection of native (.fwmod) modules for the emulator.
 *
 * Phase 4 scope: decode the container, validate its integrity, and report
 * whether the host could run it (ABI compatibility + an execution backend for
 * its arch). Actually *executing* the flat binary is Phase 5 — the emulator has
 * no execution backend yet, so a structurally perfect module still reports
 * `runnable: false` with the reason "no execution backend".
 *
 * This boundary is deliberately resilient: a malformed module on the SD card
 * must not throw out of game resolution — it surfaces as problems instead.
 */

import { ABI_VERSION, Arch, archName, decodeFwmod, FwModule } from "./format.js";

/** Flat description of a decoded module, safe to hand to UI / dev tools. */
export interface NativeModuleInfo {
  arch: number;
  archLabel: string;
  abiVersion: number;
  formatVersion: number;
  codeSize: number;
  bssSize: number;
  entryOffset: number;
  loadAddr: number;
  flags: number;
  crc32: number;
}

export interface FwmodInspection {
  /** Decoded module fields, or null when the buffer could not be decoded. */
  info: NativeModuleInfo | null;
  /** Integrity / structural problems (from FwModule.validate()). */
  problems: string[];
  /** True when decoded, valid, and built against a compatible ABI. */
  loadable: boolean;
  /**
   * True when the host could actually execute it now. Always false in Phase 4
   * (no execution backend); kept distinct from `loadable` so Phase 5 can flip
   * it on per-arch without changing callers.
   */
  runnable: boolean;
  /** Why it isn't runnable (even when loadable), for display. */
  reason: string | null;
}

/** Architectures the emulator can currently execute: wasm32 (WasmModuleRuntime)
 *  and xtensa-lx7 (the call0 XtensaModuleRuntime interpreter). */
export const SUPPORTED_ARCHS: readonly number[] = [Arch.Wasm32, Arch.XtensaLx7];

function toInfo(m: FwModule): NativeModuleInfo {
  return {
    arch: m.arch,
    archLabel: m.archLabel,
    abiVersion: m.abiVersion,
    formatVersion: m.formatVersion,
    codeSize: m.codeSize,
    bssSize: m.bssSize,
    entryOffset: m.entryOffset,
    loadAddr: m.loadAddr,
    flags: m.flags,
    crc32: m.computedCrc32,
  };
}

/**
 * Decode + validate a .fwmod buffer without throwing. `hostAbi` is the ABI
 * version the host implements; a module built against a newer ABI is not
 * loadable (the host can't satisfy the jump table it expects).
 */
export function loadFwmod(
  bytes: Uint8Array,
  hostAbi: number = ABI_VERSION,
): FwmodInspection {
  let module: FwModule;
  try {
    module = decodeFwmod(bytes);
  } catch (e) {
    return {
      info: null,
      problems: [e instanceof Error ? e.message : String(e)],
      loadable: false,
      runnable: false,
      reason: "not a valid .fwmod",
    };
  }

  const problems = module.validate();
  if (module.abiVersion > hostAbi) {
    problems.push(
      `module needs ABI v${module.abiVersion} but host provides v${hostAbi}`,
    );
  }

  const loadable = problems.length === 0;
  const hasBackend = SUPPORTED_ARCHS.includes(module.arch);
  const runnable = loadable && hasBackend;

  let reason: string | null = null;
  if (!loadable) reason = problems[0] ?? "invalid module";
  else if (!hasBackend) {
    reason = `no execution backend for ${archName(module.arch)} (Phase 5)`;
  }

  return { info: toInfo(module), problems, loadable, runnable, reason };
}
