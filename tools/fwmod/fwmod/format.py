"""The .fwmod container codec (writer + reader).

This is the Python half of a format defined once in docs/fwmod-format.md and
implemented twice (here, and in TS at packages/emulator-core/src/fwmod/). A
committed golden fixture is decoded by both sides' tests so they cannot drift.

Stdlib only: struct for the header, zlib for CRC-32.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass, field
from enum import IntEnum

MAGIC = b"FWMD"
FORMAT_VERSION = 1
ABI_VERSION = 1
HEADER_SIZE = 32

# Header layout (little-endian): magic[4], format_version u16, abi_version u16,
# arch u8, flags u8, reserved u16, code_size u32, bss_size u32, entry_offset u32,
# load_addr u32, crc32 u32. See docs/fwmod-format.md for the field table.
_HEADER = struct.Struct("<4sHHBBHIIIII")
assert _HEADER.size == HEADER_SIZE

FLAG_PIC = 0x01


class Arch(IntEnum):
    UNKNOWN = 0
    XTENSA_LX7 = 1
    HOST_X86 = 2
    HOST_X86_64 = 3
    WASM32 = 4

    @classmethod
    def from_name(cls, name: str) -> "Arch":
        try:
            return _ARCH_BY_NAME[name]
        except KeyError:
            valid = ", ".join(_ARCH_BY_NAME)
            raise ValueError(f"unknown arch {name!r} (expected one of: {valid})")

    @property
    def cli_name(self) -> str:
        return _ARCH_TO_NAME[self]


_ARCH_BY_NAME = {
    "unknown": Arch.UNKNOWN,
    "xtensa-lx7": Arch.XTENSA_LX7,
    "host-x86": Arch.HOST_X86,
    "host-x86_64": Arch.HOST_X86_64,
    "wasm32": Arch.WASM32,
}
_ARCH_TO_NAME = {v: k for k, v in _ARCH_BY_NAME.items()}


def crc32(payload: bytes) -> int:
    """CRC-32/ISO-HDLC (zlib variant). crc32(b"123456789") == 0xCBF43926."""
    return zlib.crc32(payload) & 0xFFFFFFFF


@dataclass
class FwModule:
    """A decoded .fwmod: its header fields plus the raw payload."""

    payload: bytes
    arch: Arch = Arch.UNKNOWN
    abi_version: int = ABI_VERSION
    format_version: int = FORMAT_VERSION
    flags: int = 0
    bss_size: int = 0
    entry_offset: int = 0
    load_addr: int = 0
    reserved: int = 0
    # Populated by decode(); the CRC stored in the file (may differ from the
    # recomputed CRC for a corrupt file). encode() always writes a fresh CRC.
    stored_crc32: int | None = field(default=None)
    # Populated by decode() with the total input length, so validate() can flag
    # trailing bytes after the payload. None for constructor-built modules.
    source_size: int | None = field(default=None)

    @property
    def code_size(self) -> int:
        return len(self.payload)

    @property
    def computed_crc32(self) -> int:
        return crc32(self.payload)

    def _field_ranges(self) -> tuple[tuple[str, int, int], ...]:
        """(name, value, max) for every fixed-width header field."""
        return (
            ("format_version", self.format_version, 0xFFFF),
            ("abi_version", self.abi_version, 0xFFFF),
            ("reserved", self.reserved, 0xFFFF),
            ("arch", int(self.arch), 0xFF),
            ("flags", self.flags, 0xFF),
            ("code_size", self.code_size, 0xFFFFFFFF),
            ("bss_size", self.bss_size, 0xFFFFFFFF),
            ("entry_offset", self.entry_offset, 0xFFFFFFFF),
            ("load_addr", self.load_addr, 0xFFFFFFFF),
        )

    def encode(self) -> bytes:
        """Serialize to bytes, computing the payload CRC fresh. Raises ValueError
        on an out-of-range field rather than letting struct.pack raise."""
        for name, value, hi in self._field_ranges():
            if not (0 <= value <= hi):
                raise ValueError(f"{name} out of range: {value} (allowed 0..{hi})")
        header = _HEADER.pack(
            MAGIC,
            self.format_version,
            self.abi_version,
            int(self.arch),
            self.flags,
            self.reserved,
            self.code_size,
            self.bss_size,
            self.entry_offset,
            self.load_addr,
            self.computed_crc32,
        )
        return header + self.payload

    def validate(self) -> list[str]:
        """Return a list of problems; empty means a loadable module."""
        problems: list[str] = []
        for name, value, hi in self._field_ranges():
            if not (0 <= value <= hi):
                problems.append(f"{name} out of range: {value} (allowed 0..{hi})")
        if self.format_version != FORMAT_VERSION:
            problems.append(
                f"unsupported format_version {self.format_version} "
                f"(this tool writes {FORMAT_VERSION})"
            )
        if self.reserved != 0:
            problems.append(f"reserved field must be 0, got {self.reserved}")
        if self.code_size < 1:
            problems.append("empty payload (code_size must be >= 1)")
        if self.entry_offset >= self.code_size:
            problems.append(
                f"entry_offset {self.entry_offset} is outside the "
                f"{self.code_size}-byte payload"
            )
        if self.stored_crc32 is not None and self.stored_crc32 != self.computed_crc32:
            problems.append(
                f"crc32 mismatch: header says {self.stored_crc32:#010x}, "
                f"payload is {self.computed_crc32:#010x}"
            )
        if (
            self.source_size is not None
            and self.source_size != HEADER_SIZE + self.code_size
        ):
            trailing = self.source_size - HEADER_SIZE - self.code_size
            problems.append(
                f"file is {self.source_size} bytes, expected {HEADER_SIZE + self.code_size} "
                f"({trailing:+d} trailing byte(s) after the payload)"
            )
        return problems


def decode(data: bytes) -> FwModule:
    """Parse a .fwmod buffer. Lenient: parses any 32+ byte buffer with the right
    magic so tooling can inspect malformed files. Use validate() to gate loading.
    """
    if len(data) < HEADER_SIZE:
        raise ValueError(
            f"too small to be a .fwmod: {len(data)} bytes (need >= {HEADER_SIZE})"
        )
    (
        magic,
        format_version,
        abi_version,
        arch,
        flags,
        reserved,
        code_size,
        bss_size,
        entry_offset,
        load_addr,
        stored_crc,
    ) = _HEADER.unpack_from(data, 0)
    if magic != MAGIC:
        raise ValueError(f"bad magic {magic!r} (expected {MAGIC!r})")

    available = len(data) - HEADER_SIZE
    if code_size > available:
        raise ValueError(
            f"truncated: header claims {code_size}-byte payload but only "
            f"{available} bytes follow the header"
        )
    payload = data[HEADER_SIZE : HEADER_SIZE + code_size]

    return FwModule(
        payload=payload,
        arch=Arch(arch) if arch in _ARCH_TO_NAME else Arch.UNKNOWN,
        abi_version=abi_version,
        format_version=format_version,
        flags=flags,
        bss_size=bss_size,
        entry_offset=entry_offset,
        load_addr=load_addr,
        reserved=reserved,
        stored_crc32=stored_crc,
        source_size=len(data),
    )
