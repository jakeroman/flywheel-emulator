import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fwmod.cli import main  # noqa: E402
from fwmod.format import HEADER_SIZE, Arch, FwModule, decode  # noqa: E402


def run(argv):
    """Invoke the CLI, swallowing its stdout/stderr; return the exit code."""
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main(argv)
    return code, out.getvalue(), err.getvalue()


class TestCli(unittest.TestCase):
    def test_pack_inspect_validate(self):
        with tempfile.TemporaryDirectory() as d:
            payload = Path(d) / "p.bin"
            payload.write_bytes(b"\x90\x90\xc3")
            out = Path(d) / "m.fwmod"
            code, _, _ = run(
                ["pack", str(payload), "-o", str(out), "--arch", "host-x86", "--bss", "16"]
            )
            self.assertEqual(code, 0)
            self.assertTrue(out.exists())

            module = decode(out.read_bytes())
            self.assertEqual(module.code_size, 3)
            self.assertEqual(module.arch, Arch.HOST_X86)
            self.assertEqual(module.bss_size, 16)
            self.assertEqual(module.validate(), [])

            self.assertEqual(run(["validate", str(out)])[0], 0)
            self.assertEqual(run(["inspect", str(out)])[0], 0)

    def test_pack_out_of_range_exits_cleanly(self):
        # Out-of-range header field must produce a clean error/exit-1, not an
        # uncaught struct.error traceback.
        with tempfile.TemporaryDirectory() as d:
            payload = Path(d) / "p.bin"
            payload.write_bytes(b"\x90")
            out = Path(d) / "m.fwmod"
            code, _, err = run(["pack", str(payload), "-o", str(out), "--abi", "70000"])
            self.assertEqual(code, 1)
            self.assertNotIn("Traceback", err)
            self.assertIn("out of range", err.lower())
            self.assertFalse(out.exists())

    def test_pack_rejects_empty_payload(self):
        with tempfile.TemporaryDirectory() as d:
            payload = Path(d) / "empty.bin"
            payload.write_bytes(b"")
            out = Path(d) / "m.fwmod"
            code, _, err = run(["pack", str(payload), "-o", str(out)])
            self.assertEqual(code, 1)
            self.assertFalse(out.exists())
            self.assertIn("invalid", err.lower())

    def test_validate_fails_on_corrupt(self):
        with tempfile.TemporaryDirectory() as d:
            blob = bytearray(FwModule(payload=b"abcd", arch=Arch.HOST_X86).encode())
            blob[HEADER_SIZE] ^= 0xFF
            bad = Path(d) / "bad.fwmod"
            bad.write_bytes(bytes(blob))
            code, out, _ = run(["validate", str(bad)])
            self.assertEqual(code, 1)
            self.assertIn("INVALID", out)

    def test_build_reports_missing_toolchain(self):
        # With an explicit, nonexistent compiler, build must fail cleanly (not
        # crash) — exercising the toolchain-discovery error path without needing
        # a real compiler in CI.
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "m.c"
            src.write_text("const void *fw_main(const void *a){return a;}\n")
            out = Path(d) / "m.fwmod"
            code, _, err = run(
                ["build", str(src), "-o", str(out), "--cc", "definitely-not-a-real-cc"]
            )
            self.assertEqual(code, 1)
            self.assertIn("not found", err.lower())


if __name__ == "__main__":
    unittest.main()
