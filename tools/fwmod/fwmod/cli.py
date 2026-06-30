"""The `fwmod` command-line interface.

Subcommands:
  build     compile a C source into a .fwmod (needs a C toolchain)
  pack      wrap an existing flat binary into a .fwmod (no compiler needed)
  inspect   print a .fwmod's header fields
  validate  check a .fwmod's integrity (exit 1 on problems)
"""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

from .format import ABI_VERSION, FLAG_PIC, Arch, FwModule, decode
from .toolchain import (
    DEFAULT_LOAD_ADDR,
    Toolchain,
    ToolchainError,
    compile_module,
    compile_wasm_module,
    find_clang,
)

_PKG_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INCLUDE = _PKG_ROOT / "include"
DEFAULT_LD_SCRIPT = _PKG_ROOT / "ld" / "dynregion.ld"

_ARCH_CHOICES = ["unknown", "xtensa-lx7", "host-x86", "host-x86_64", "wasm32"]


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 2
    try:
        return args.func(args)
    except (ToolchainError, OSError, ValueError, struct.error) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fwmod", description="Flywheel native module toolchain"
    )
    sub = parser.add_subparsers(dest="command")

    # --- build ---
    b = sub.add_parser("build", help="compile a C source into a .fwmod")
    b.add_argument("source", help="C source file")
    b.add_argument("-o", "--output", required=True, help="output .fwmod path")
    b.add_argument(
        "--arch", choices=_ARCH_CHOICES, default="host-x86", help="target architecture"
    )
    b.add_argument("--cc", help="path to the C compiler (overrides discovery)")
    b.add_argument("--ld", help="path to ld")
    b.add_argument("--objcopy", help="path to objcopy")
    b.add_argument("--toolchain-dir", help="directory holding the toolchain binaries")
    b.add_argument(
        "--prefix",
        default="",
        help="tool name prefix, e.g. xtensa-esp32s3-elf- for the ESP32-S3 cross toolchain",
    )
    b.add_argument(
        "--load-addr",
        type=_int0,
        help="fixed link base (default per arch); accepts 0x hex",
    )
    b.add_argument(
        "--include", action="append", default=[], help="extra include dir (repeatable)"
    )
    b.add_argument(
        "--ld-script", help=f"linker script (default: {DEFAULT_LD_SCRIPT.name})"
    )
    b.add_argument(
        "--cflag", action="append", default=[], help="extra compiler flag (repeatable)"
    )
    b.add_argument("-v", "--verbose", action="store_true", help="echo toolchain commands")
    b.set_defaults(func=_cmd_build)

    # --- pack ---
    p = sub.add_parser(
        "pack", help="wrap an existing flat binary into a .fwmod (no compiler)"
    )
    p.add_argument("payload", help="flat binary payload file")
    p.add_argument("-o", "--output", required=True, help="output .fwmod path")
    p.add_argument("--arch", choices=_ARCH_CHOICES, default="unknown")
    p.add_argument("--abi", type=int, default=ABI_VERSION, help="ABI version")
    p.add_argument("--entry-offset", type=_int0, default=0)
    p.add_argument("--bss", type=_int0, default=0, help="bss size")
    p.add_argument("--load-addr", type=_int0, default=0)
    p.add_argument("--pic", action="store_true", help="set the position-independent flag")
    p.set_defaults(func=_cmd_pack)

    # --- inspect ---
    i = sub.add_parser("inspect", help="print a .fwmod's header fields")
    i.add_argument("file", help=".fwmod file")
    i.set_defaults(func=_cmd_inspect)

    # --- validate ---
    v = sub.add_parser("validate", help="check a .fwmod's integrity")
    v.add_argument("file", help=".fwmod file")
    v.set_defaults(func=_cmd_validate)

    return parser


def _cmd_build(args: argparse.Namespace) -> int:
    arch = Arch.from_name(args.arch)
    includes = (str(DEFAULT_INCLUDE), *args.include)

    if arch is Arch.WASM32:
        # wasm32 is a distinct pipeline: clang + wasm-ld, the .wasm IS the
        # payload (no fixed-base link / objcopy). See compile_wasm_module.
        module = compile_wasm_module(
            find_clang(args.cc, args.toolchain_dir),
            args.source,
            include_dirs=includes,
            extra_cflags=tuple(args.cflag),
            verbose=args.verbose,
        )
    else:
        tc = Toolchain.discover(
            prefix=args.prefix,
            bindir=args.toolchain_dir,
            cc=args.cc,
            ld=args.ld,
            objcopy=args.objcopy,
        )
        ld_script = args.ld_script or (
            str(DEFAULT_LD_SCRIPT) if DEFAULT_LD_SCRIPT.exists() else None
        )
        module = compile_module(
            tc,
            args.source,
            arch,
            load_addr=args.load_addr,
            include_dirs=includes,
            ld_script=ld_script,
            extra_cflags=tuple(args.cflag),
            verbose=args.verbose,
        )

    problems = module.validate()
    if problems:
        print("error: built module failed validation:", file=sys.stderr)
        for pr in problems:
            print(f"  - {pr}", file=sys.stderr)
        return 1
    _write(args.output, module)
    print(f"built {args.output}")
    _print_module(module)
    return 0


def _cmd_pack(args: argparse.Namespace) -> int:
    payload = Path(args.payload).read_bytes()
    module = FwModule(
        payload=payload,
        arch=Arch.from_name(args.arch),
        abi_version=args.abi,
        entry_offset=args.entry_offset,
        bss_size=args.bss,
        load_addr=args.load_addr,
        flags=FLAG_PIC if args.pic else 0,
    )
    problems = module.validate()
    if problems:
        print("error: cannot pack an invalid module:", file=sys.stderr)
        for pr in problems:
            print(f"  - {pr}", file=sys.stderr)
        return 1
    _write(args.output, module)
    print(f"packed {args.output}")
    _print_module(module)
    return 0


def _cmd_inspect(args: argparse.Namespace) -> int:
    module = decode(Path(args.file).read_bytes())
    _print_module(module)
    problems = module.validate()
    if problems:
        print("problems:")
        for pr in problems:
            print(f"  - {pr}")
    return 0


def _cmd_validate(args: argparse.Namespace) -> int:
    module = decode(Path(args.file).read_bytes())
    problems = module.validate()
    if problems:
        print(f"INVALID: {args.file}")
        for pr in problems:
            print(f"  - {pr}")
        return 1
    print(f"OK: {args.file}")
    return 0


def _write(path: str, module: FwModule) -> None:
    Path(path).write_bytes(module.encode())


def _print_module(module: FwModule) -> None:
    crc = module.computed_crc32
    print(f"  format_version : {module.format_version}")
    print(f"  abi_version    : {module.abi_version}")
    print(f"  arch           : {module.arch.cli_name} ({int(module.arch)})")
    print(f"  flags          : 0x{module.flags:02x}")
    print(f"  code_size      : {module.code_size} bytes")
    print(f"  bss_size       : {module.bss_size} bytes")
    print(f"  entry_offset   : 0x{module.entry_offset:x}")
    print(f"  load_addr      : 0x{module.load_addr:08x}")
    print(f"  crc32          : 0x{crc:08x}")


def _int0(text: str) -> int:
    """Parse an int with optional 0x/0o/0b prefix."""
    return int(text, 0)


if __name__ == "__main__":
    sys.exit(main())
