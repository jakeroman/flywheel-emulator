"""Regenerate the cross-language conformance fixture.

Run from tools/fwmod:  python fixtures/make_golden.py

Produces a deterministic golden.fwmod plus golden.json describing its decoded
fields. Both the Python (tests/test_format.py) and TypeScript
(packages/emulator-core/src/fwmod/conformance.test.ts) suites decode the same
bytes and assert against golden.json, so the two codecs cannot drift.
"""

from __future__ import annotations

import json
from pathlib import Path

# Make `import fwmod` work when run directly from tools/fwmod.
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fwmod.format import FLAG_PIC, Arch, FwModule  # noqa: E402

HERE = Path(__file__).resolve().parent

# A fixed, recognizable payload so the CRC is stable across regenerations.
PAYLOAD = bytes(range(64))

MODULE = FwModule(
    payload=PAYLOAD,
    arch=Arch.XTENSA_LX7,
    abi_version=1,
    entry_offset=0,
    bss_size=256,
    load_addr=0x3FC88000,
    flags=FLAG_PIC,  # exercise a nonzero flags byte across languages
)


def main() -> None:
    blob = MODULE.encode()
    (HERE / "golden.fwmod").write_bytes(blob)

    golden = {
        "file_size": len(blob),
        "format_version": MODULE.format_version,
        "abi_version": MODULE.abi_version,
        "arch": int(MODULE.arch),
        "arch_name": MODULE.arch.cli_name,
        "flags": MODULE.flags,
        "code_size": MODULE.code_size,
        "bss_size": MODULE.bss_size,
        "entry_offset": MODULE.entry_offset,
        "load_addr": MODULE.load_addr,
        "crc32": MODULE.computed_crc32,
        "payload_hex": PAYLOAD.hex(),
    }
    (HERE / "golden.json").write_text(json.dumps(golden, indent=2) + "\n")

    # The arch int->name table, so the TS side can assert its independently
    # maintained table matches Python's (guards the duplicated arch labels).
    arch_table = {str(int(a)): a.cli_name for a in Arch}
    (HERE / "arch_table.json").write_text(json.dumps(arch_table, indent=2) + "\n")

    print(f"wrote golden.fwmod ({len(blob)} bytes), golden.json, arch_table.json")
    print(f"crc32 = 0x{MODULE.computed_crc32:08x}")


if __name__ == "__main__":
    main()
