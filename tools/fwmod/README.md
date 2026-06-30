# `fwmod` — Flywheel native module toolchain

`fwmod` compiles freestanding C against the Flywheel module ABI and packs the
result into a validated `.fwmod` container that the BIOS can load. It is the
Phase 4 "separate native CLI" (the browser emulator can't compile C); native
module *execution* arrives in Phase 5.

- Module ABI: [`include/fw_api.h`](include/fw_api.h) · [docs/module-abi.md](../../docs/module-abi.md)
- Container format: [docs/fwmod-format.md](../../docs/fwmod-format.md)
- The codec is defined once and implemented twice (Python writer here, TS
  reader in `@flywheel/emulator-core`); a [golden fixture](fixtures/golden.fwmod)
  is decoded by both test suites so they can't drift.

Python 3.12+, standard library only. Run from this directory.

## Commands

```sh
# Compile a C source into a .fwmod (needs a C toolchain).
python -m fwmod build examples/hello.c -o hello.fwmod --arch host-x86

# Target the real hardware (ESP32-S3) with the ESP-IDF cross toolchain:
python -m fwmod build examples/hello.c -o hello.fwmod \
    --arch xtensa-lx7 --prefix xtensa-esp32s3-elf-

# Wrap an already-built flat binary (no compiler needed).
python -m fwmod pack payload.bin -o mod.fwmod --arch xtensa-lx7 --entry-offset 0

# Inspect / integrity-check a .fwmod.
python -m fwmod inspect hello.fwmod
python -m fwmod validate hello.fwmod   # exit 1 on problems
```

### Locating the toolchain

`build` resolves each tool (`gcc`, `ld`, `objcopy`, and optionally `objdump`/`nm`)
in this order: an explicit `--cc`/`--ld`/`--objcopy`, then `<dir>/<prefix><tool>`
when `--toolchain-dir <dir>` is given, then `<prefix><tool>` on `PATH`. The
tool's own bin directory is added to the subprocess `PATH` so an off-`PATH`
toolchain can still find its runtime DLLs and helper programs (e.g. MinGW's
`cc1`). Example with an off-PATH MinGW:

```sh
python -m fwmod build examples/hello.c -o hello.fwmod \
    --arch host-x86 --toolchain-dir C:/MinGW/bin
```

## How `build` works

1. **compile** — `gcc -c` with `-ffreestanding -nostdlib`-style flags and
   `-ffunction-sections`, against `include/fw_api.h`.
2. **link** — `ld -T ld/dynregion.ld` places the code at the fixed dynamic-region
   base (`--load-addr`, default per arch) and forces `fw_main` to the front.
3. **objcopy** — `-O binary` strips the linked image to the loadable bytes.
4. **pack** — prepend the validating `.fwmod` header (magic, versions, arch,
   sizes, entry offset, CRC-32) and write the file.

`entry_offset` and `bss_size` are read back from the linked image (`nm` /
`objdump`); the linker script keeps `fw_main` first so the entry offset is `0`.

The linker script handles both ELF (Xtensa) and PE/COFF (host MinGW) section
naming, so the same pipeline serves dev and hardware targets.

## Tests

```sh
python -m unittest discover -s tests
python fixtures/make_golden.py   # regenerate the cross-language fixture
```

The unittests (and CI) cover the codec, the golden cross-language fixture, and
the `pack` / `inspect` / `validate` paths — none of which need a C compiler. The
`build` **success** path (compile → link → objcopy → pack) is exercised
manually, since CI has no cross toolchain; the committed
`fixtures/hello-host-x86.fwmod` is a frozen real-compiler artifact the TS reader
verifies it can still decode. To run the real build locally:

```sh
python -m fwmod build examples/hello.c -o /tmp/hello.fwmod \
    --arch host-x86 --toolchain-dir <your gcc/binutils bin> -v
python -m fwmod validate /tmp/hello.fwmod
```
