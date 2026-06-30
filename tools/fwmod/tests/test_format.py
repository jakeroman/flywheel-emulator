import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fwmod.format import (  # noqa: E402
    HEADER_SIZE,
    Arch,
    FwModule,
    crc32,
    decode,
)

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"


class TestCrc32(unittest.TestCase):
    def test_check_vector(self):
        self.assertEqual(crc32(b"123456789"), 0xCBF43926)

    def test_empty(self):
        self.assertEqual(crc32(b""), 0)


class TestRoundTrip(unittest.TestCase):
    def test_round_trip(self):
        m = FwModule(
            payload=b"\x01\x02\x03\x04",
            arch=Arch.HOST_X86,
            entry_offset=1,
            bss_size=8,
            load_addr=0x1000,
        )
        d = decode(m.encode())
        self.assertEqual(d.payload, m.payload)
        self.assertEqual(d.arch, Arch.HOST_X86)
        self.assertEqual(d.entry_offset, 1)
        self.assertEqual(d.bss_size, 8)
        self.assertEqual(d.load_addr, 0x1000)
        self.assertEqual(d.stored_crc32, m.computed_crc32)
        self.assertEqual(d.validate(), [])


class TestGoldenFixture(unittest.TestCase):
    def test_decodes_to_expected_fields(self):
        golden = json.loads((FIXTURES / "golden.json").read_text())
        d = decode((FIXTURES / "golden.fwmod").read_bytes())
        self.assertEqual(d.format_version, golden["format_version"])
        self.assertEqual(d.abi_version, golden["abi_version"])
        self.assertEqual(int(d.arch), golden["arch"])
        self.assertEqual(d.arch.cli_name, golden["arch_name"])
        self.assertEqual(d.flags, golden["flags"])
        self.assertEqual(d.code_size, golden["code_size"])
        self.assertEqual(d.bss_size, golden["bss_size"])
        self.assertEqual(d.entry_offset, golden["entry_offset"])
        self.assertEqual(d.load_addr, golden["load_addr"])
        self.assertEqual(d.computed_crc32, golden["crc32"])
        self.assertEqual(d.stored_crc32, golden["crc32"])
        self.assertEqual(d.payload.hex(), golden["payload_hex"])
        self.assertEqual(d.validate(), [])


class TestValidation(unittest.TestCase):
    def test_crc_mismatch(self):
        blob = bytearray(FwModule(payload=b"abcd", arch=Arch.HOST_X86).encode())
        blob[HEADER_SIZE] ^= 0xFF  # corrupt the first payload byte
        problems = decode(bytes(blob)).validate()
        self.assertTrue(any("crc32 mismatch" in p for p in problems), problems)

    def test_entry_offset_out_of_range(self):
        problems = FwModule(payload=b"\x00", entry_offset=5).validate()
        self.assertTrue(any("entry_offset" in p for p in problems), problems)

    def test_empty_payload(self):
        problems = FwModule(payload=b"").validate()
        self.assertTrue(any("empty payload" in p for p in problems), problems)

    def test_reserved_must_be_zero(self):
        problems = FwModule(payload=b"\x00", reserved=7).validate()
        self.assertTrue(any("reserved" in p for p in problems), problems)


class TestDecodeErrors(unittest.TestCase):
    def test_too_small(self):
        with self.assertRaises(ValueError):
            decode(b"\x00" * 10)

    def test_bad_magic(self):
        blob = bytearray(FwModule(payload=b"\x01").encode())
        blob[0] = 0x00
        with self.assertRaises(ValueError):
            decode(bytes(blob))

    def test_truncated_payload(self):
        blob = FwModule(payload=b"\x01\x02\x03\x04\x05\x06\x07\x08").encode()
        with self.assertRaises(ValueError):
            decode(blob[:-2])


class TestArch(unittest.TestCase):
    def test_from_name_roundtrip(self):
        self.assertEqual(Arch.from_name("xtensa-lx7"), Arch.XTENSA_LX7)
        self.assertEqual(Arch.XTENSA_LX7.cli_name, "xtensa-lx7")

    def test_from_name_invalid(self):
        with self.assertRaises(ValueError):
            Arch.from_name("sparc")

    def test_unknown_arch_byte_coerces_to_unknown(self):
        blob = bytearray(FwModule(payload=b"abcd", arch=Arch.HOST_X86).encode())
        blob[8] = 7  # arch byte outside the known set (CRC is over payload only)
        m = decode(bytes(blob))
        self.assertEqual(int(m.arch), int(Arch.UNKNOWN))
        self.assertEqual(m.validate(), [])


class TestRangeValidation(unittest.TestCase):
    def test_validate_reports_out_of_range(self):
        problems = FwModule(payload=b"\x01", abi_version=70000).validate()
        self.assertTrue(
            any("abi_version out of range" in p for p in problems), problems
        )

    def test_encode_raises_instead_of_struct_error(self):
        with self.assertRaises(ValueError):
            FwModule(payload=b"\x01", bss_size=-1).encode()
        with self.assertRaises(ValueError):
            FwModule(payload=b"\x01", load_addr=0x100000000).encode()


class TestTrailingBytes(unittest.TestCase):
    def test_validate_flags_trailing_bytes(self):
        blob = FwModule(payload=b"abcd", arch=Arch.HOST_X86).encode() + b"junk"
        problems = decode(blob).validate()
        self.assertTrue(any("trailing" in p for p in problems), problems)

    def test_exact_length_is_clean(self):
        blob = FwModule(payload=b"abcd", arch=Arch.HOST_X86).encode()
        self.assertEqual(decode(blob).validate(), [])


if __name__ == "__main__":
    unittest.main()
