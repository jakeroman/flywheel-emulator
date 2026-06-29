# Flywheel Emulator

A web-based emulator and development environment for the **Flywheel** handheld —
an ESP32-S3 device with a 400×240 Sharp reflective memory display, a Game
Boy-style gamepad, SD-card content, and a solar/LFP power system.

The goal is to iterate on the BIOS and write/test Lua applications without
physical hardware, behind a clean hardware abstraction layer that real
instruction-level execution can eventually slot into.

## Architecture

The whole design hinges on one boundary: the **hardware abstraction layer
(HAL)**. The BIOS and Lua call the HAL; the emulator supplies a JavaScript
implementation. Get this seam clean and everything else follows.

```
packages/
  emulator-core/     Framework-agnostic TypeScript. The HAL + emulated impls.
    src/hal/         Contracts: display, gamepad, power, sd, audio, device
    src/device/      Emulated implementations (FrameBuffer, Gamepad, …)
  web/               React + Vite UI: the stylized device + dev tools
    src/components/  DeviceShell, DisplayCanvas, Gamepad, PowerSwitch, DevPanel
    src/hooks/       React bindings over the core's emitters
    src/input/       Keyboard → gamepad mapping
```

`@flywheel/web` consumes `@flywheel/emulator-core` directly as TypeScript
source (via a Vite alias), so there is no build step for the core during
development.

## Getting started

```bash
npm install
npm run dev        # start the Vite dev server (the device UI)
```

Other scripts:

```bash
npm run build      # production build of the web app
npm run typecheck  # typecheck every workspace
npm run format     # prettier --write
```

## Controls

| Button | Keys          |
| ------ | ------------- |
| D-pad  | Arrows / WASD |
| A      | X             |
| B      | Z             |
| Menu   | Enter         |
| Select | Shift         |

On-screen buttons can also be clicked/tapped.

## Roadmap

- **Phase 0 — Scaffold & device shell.** _(current)_ The stylized device UI:
  display canvas, working gamepad, power switch, dev-tools side panel.
- **Phase 1 — Simulated hardware layer + Lua runtime.** Full HAL + wasmoon; the
  Lua API for display, gamepad, SD, power, and audio.
- **Phase 2 — BIOS simulation.** Boot, game selector, settings, charge tracking.
- **Phase 3 — In-emulator dev environment.** Lua editor + hot-reload, SD file
  editor, live power/state inspection.
- **Phase 4 — Native C toolchain (CLI).** Compile dynamic C modules to `.fwmod`.
- **Phase 5 — Dynamic C module execution.** Evaluate QEMU/Wokwi ESP32 cores
  before hand-rolling an interpreter; build a faithfulness validation harness.
