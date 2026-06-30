"""fwmod - the Flywheel native module toolchain.

Compiles freestanding C against the fw_api ABI and packs the result into a
validated .fwmod container (see docs/fwmod-format.md and docs/module-abi.md).
"""

from .format import (
    ABI_VERSION,
    FORMAT_VERSION,
    HEADER_SIZE,
    Arch,
    FwModule,
    crc32,
    decode,
)

__version__ = "0.1.0"

__all__ = [
    "ABI_VERSION",
    "FORMAT_VERSION",
    "HEADER_SIZE",
    "Arch",
    "FwModule",
    "crc32",
    "decode",
]
