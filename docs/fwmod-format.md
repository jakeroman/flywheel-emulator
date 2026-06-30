# `.fwmod` container format (v1)

A `.fwmod` is a **native module**: freestanding C compiled to a flat binary, wrapped
in a small validating header. The BIOS loads it into a fixed dynamic region of RAM
and runs it alongside Lua apps (execution lands in Phase 5; Phase 4 produces and
validates the container).

The format is defined **once, here**, and implemented twice against this spec:

- writer — `tools/fwmod` (Python CLI), see [`tools/fwmod/fwmod/format.py`](../tools/fwmod/fwmod/format.py)
- reader/validator — `@flywheel/emulator-core`, see [`packages/emulator-core/src/fwmod/format.ts`](../packages/emulator-core/src/fwmod/format.ts)

A committed golden fixture ([`tools/fwmod/fixtures/golden.fwmod`](../tools/fwmod/fixtures/golden.fwmod))
is decoded by **both** sides' tests so the two implementations cannot drift.

## Layout

All multi-byte fields are **little-endian** (ESP32-S3 / x86 / wasm are all LE).
The header is a fixed **32 bytes**, immediately followed by the payload.

| Offset | Size | Field            | Type     | Notes                                                   |
|-------:|-----:|------------------|----------|---------------------------------------------------------|
| 0      | 4    | `magic`          | `u8[4]`  | ASCII `"FWMD"` (`46 57 4D 44`)                           |
| 4      | 2    | `format_version` | `u16`    | container format version — `1`                          |
| 6      | 2    | `abi_version`    | `u16`    | `fw_api` ABI the module was built against (see ABI doc) |
| 8      | 1    | `arch`           | `u8`     | target architecture (table below)                       |
| 9      | 1    | `flags`          | `u8`     | bit0 = position-independent; other bits reserved (0)    |
| 10     | 2    | `reserved`       | `u16`    | must be `0`                                             |
| 12     | 4    | `code_size`      | `u32`    | payload length in bytes                                 |
| 16     | 4    | `bss_size`       | `u32`    | zero-init RAM the module needs **beyond** the payload   |
| 20     | 4    | `entry_offset`   | `u32`    | offset of `fw_main` within the payload                  |
| 24     | 4    | `load_addr`      | `u32`    | fixed link base it was linked at (`0` if PIC / n/a)     |
| 28     | 4    | `crc32`          | `u32`    | CRC-32 of the payload (see below)                       |
| 32     | `code_size` | `payload` | `u8[]` | the flat binary                                      |

Total file size is exactly `32 + code_size`.

### `arch` values

| Value | Architecture        | Meaning                                               |
|------:|---------------------|-------------------------------------------------------|
| 0     | `unknown`           | unspecified                                           |
| 1     | `xtensa-lx7`        | ESP32-S3 — the real hardware target                   |
| 2     | `host-x86`          | 32-bit x86 host build (MinGW/dev), pipeline proof     |
| 3     | `host-x86_64`       | 64-bit x86 host build (dev)                           |
| 4     | `wasm32`            | WebAssembly build (dev/in-browser)                    |

Host/wasm arches are **dev** targets that exercise the toolchain and container
without hardware. The emulator's loader will run a module only when its `arch`
matches the active execution backend (Phase 5). A decoder coerces an
**unrecognized** `arch` byte to `0` (unknown), so both implementations agree on
out-of-range values.

### CRC-32

Standard **CRC-32/ISO-HDLC** (the zlib / IEEE-802.3 / PNG variant): reflected,
polynomial `0xEDB88320`, init `0xFFFFFFFF`, final XOR `0xFFFFFFFF`. Computed over
the **payload bytes only** (not the header). Check value: `crc32("123456789") == 0xCBF43926`.

## Validation

Decoding and validation are split. **`decode()` is lenient** — it parses any
buffer so tooling can inspect malformed files — and throws only on a
structurally impossible buffer:

- shorter than the 32-byte header
- `magic != "FWMD"`
- declared `code_size` exceeds the bytes after the header (truncated)

**`validate()`** then enforces a *loadable* module and reports every problem found:

1. `format_version` is known (`== 1`)
2. every fixed-width field is within its `u8`/`u16`/`u32` range
3. `reserved == 0`
4. `code_size >= 1`
5. `entry_offset < code_size`
6. recomputed CRC-32 of the payload `== crc32`
7. total input length `== 32 + code_size` (no trailing bytes) — checked when the
   module came from `decode()`, which records the source length

Callers additionally check `abi_version` and `arch` against what they can run.
