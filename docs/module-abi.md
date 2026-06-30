# Flywheel native module ABI (v1)

A native module is freestanding C that the BIOS loads from a [`.fwmod`](./fwmod-format.md)
and runs alongside Lua apps. The module **never links host symbols directly**.
Instead the host hands it a pointer to a jump table (`fw_api_t`) at entry, and the
module calls back through that table. The struct's memory layout **is** the ABI.

The canonical header is [`tools/fwmod/include/fw_api.h`](../tools/fwmod/include/fw_api.h).
The surface deliberately mirrors the Lua `fw` API
([`flywheel-api.ts`](../packages/emulator-core/src/lua/flywheel-api.ts)) so a C
module and a Lua app are written against the same device contract.

## Entry point

```c
const fw_module_t *fw_main(const fw_api_t *api);
```

Exactly one per module. The toolchain places it at `entry_offset` in the flat
binary (offset `0` with the provided linker script). After loading, the host
calls `fw_main` **once**, passing the jump table; the module stashes `api`, wires
up its callbacks, and returns them. Returning `NULL` signals failed init.

```c
typedef struct fw_module {
    void (*init)(void);            /* once, before the first frame   */
    void (*update)(float dt);      /* per frame: advance game state  */
    void (*draw)(void);            /* per frame: render              */
} fw_module_t;
```

This mirrors the Lua `_init` / `_update` / `_draw` lifecycle.

## The jump table

`fw_api_t` (see the header for exact field order — that order is the ABI):

- `abi_version`, `width`, `height` — `abi_version` must equal `FW_ABI_VERSION`;
  the module should check it and bail if it differs.
- **input**: `btn(id)`, `btnp(id)` — held / pressed-this-frame. `id` is an
  `fw_button_t`. **Menu is reserved by the BIOS and is intentionally absent** —
  the same rule as the Lua API.
- **graphics**: `cls`, `pixel`, `line`, `rect`, `rectfill`, `circle`, `circfill`,
  `print`, `text_width`. `on` is `true` for dark ink, `false` for the light
  reflective ground (the display's "on = dark pixel" convention).
- **filesystem** (resident SD, synchronous): `fs_read(path, buf, cap)` →
  bytes read or `-1`; `fs_write(path, data, len)` → `0` or `-1`; `fs_exists(path)`.
- **sound**: `tone(freq_hz, dur_ms)`.
- **misc**: `time_ms()` → ms since load; `log(msg)` → dev console.

## Versioning

`FW_ABI_VERSION` starts at `1`. **Appending** new function pointers to the end of
`fw_api_t` is backward compatible — bump the version, and older modules (which
read a prefix) keep working. **Reordering or changing** an existing entry is a
breaking change and requires a new major ABI. A loaded module's `abi_version`
(carried in the `.fwmod` header) is checked against what the host provides.

## Building a module

```sh
python -m fwmod build mymod.c -o mymod.fwmod          # host (dev) target
python -m fwmod build mymod.c -o mymod.fwmod \
    --arch xtensa-lx7 --cc xtensa-esp32s3-elf-gcc     # real hardware target
```

The CLI compiles against `fw_api.h`, links the code to the fixed dynamic-region
base (forcing `fw_main` to offset `0`), `objcopy`s to a flat binary, and wraps it
in a validated `.fwmod`. See [`tools/fwmod/README.md`](../tools/fwmod/README.md).
