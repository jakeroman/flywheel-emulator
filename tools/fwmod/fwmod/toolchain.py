"""Driving the C toolchain: compile -> link (fixed base) -> objcopy -> flat binary.

The actual compiler/binutils are external. This layer locates them (with
explicit overrides, a toolchain dir, or PATH), runs the pipeline, and returns a
FwModule ready to pack. It is arch-agnostic: a host gcc (dev) and an
xtensa-esp32s3-elf-gcc (hardware) plug in through the same `prefix`/override
mechanism — only the tool names and the linked load address differ.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .format import Arch, FwModule

# Where each arch's flat image is linked. Host/wasm dev builds don't run yet, so
# their base is nominal (recorded in the header); the Xtensa base is a plausible
# ESP32-S3 internal-SRAM dynamic-region address.
DEFAULT_LOAD_ADDR: dict[Arch, int] = {
    Arch.XTENSA_LX7: 0x3FC88000,
    Arch.HOST_X86: 0x00100000,
    Arch.HOST_X86_64: 0x00100000,
    Arch.WASM32: 0x00000000,
    Arch.UNKNOWN: 0x00000000,
}

_CFLAGS = [
    "-Os",
    "-ffreestanding",
    "-fno-builtin",
    "-fno-stack-protector",
    "-ffunction-sections",
    "-fdata-sections",
    "-fno-asynchronous-unwind-tables",
    "-fno-pic",
    # No tentative/COMMON globals — uninitialized statics go straight to .bss so
    # bss_size accounting is deterministic across gcc versions and targets.
    "-fno-common",
    "-Wall",
    "-Wextra",
]

# Arch-specific compile flags appended to _CFLAGS. The Xtensa call0 ABI drops
# register windows for a conventional stack-based calling convention — the
# single highest-leverage choice for a tractable future Xtensa interpreter
# (Phase 5 hardware-faithful backend), and harmless to bake in now.
_ARCH_CFLAGS: dict[Arch, list[str]] = {
    Arch.XTENSA_LX7: ["-mabi=call0"],
}


class ToolchainError(Exception):
    """A tool is missing or a compile/link/objcopy step failed."""


@dataclass
class Toolchain:
    cc: str
    ld: str
    objcopy: str
    objdump: str | None = None
    nm: str | None = None
    prefix: str = ""

    @classmethod
    def discover(
        cls,
        prefix: str = "",
        bindir: str | None = None,
        cc: str | None = None,
        ld: str | None = None,
        objcopy: str | None = None,
    ) -> "Toolchain":
        """Locate the toolchain. Resolution order per tool: explicit override,
        then `<bindir>/<prefix><tool>`, then `<prefix><tool>` on PATH."""

        def resolve(name: str, explicit: str | None) -> str | None:
            if explicit:
                if Path(explicit).exists() or shutil.which(explicit):
                    return explicit
                raise ToolchainError(f"{name} not found at {explicit!r}")
            cand = f"{prefix}{name}"
            if bindir:
                for ext in ((".exe", "") if os.name == "nt" else ("",)):
                    p = Path(bindir) / f"{cand}{ext}"
                    if p.exists():
                        return str(p)
            return shutil.which(cand)

        cc_p = resolve("gcc", cc)
        ld_p = resolve("ld", ld)
        oc_p = resolve("objcopy", objcopy)

        missing = [n for n, v in (("gcc", cc_p), ("ld", ld_p), ("objcopy", oc_p)) if not v]
        if missing:
            raise ToolchainError(_missing_message(missing, prefix, bindir))

        # nm/objdump are read-back helpers. If --cc was an absolute path with no
        # --toolchain-dir, look for them next to it so they match the chosen
        # toolchain rather than a foreign host nm/objdump on PATH.
        cc_dir = os.path.dirname(cc_p) if cc_p else ""
        aux_bindir = bindir or cc_dir or None

        def resolve_aux(name: str) -> str | None:
            cand = f"{prefix}{name}"
            if aux_bindir:
                for ext in (".exe", "") if os.name == "nt" else ("",):
                    p = Path(aux_bindir) / f"{cand}{ext}"
                    if p.exists():
                        return str(p)
            return shutil.which(cand)

        return cls(
            cc=cc_p,  # type: ignore[arg-type]
            ld=ld_p,  # type: ignore[arg-type]
            objcopy=oc_p,  # type: ignore[arg-type]
            objdump=resolve_aux("objdump"),
            nm=resolve_aux("nm"),
            prefix=prefix,
        )

    def subprocess_env(self) -> dict[str, str]:
        """Env for running the tools, with their own bin dir(s) on PATH.

        A toolchain invoked by absolute path (e.g. an off-PATH MinGW) still
        spawns helper programs (cc1, the assembler) and loads runtime DLLs from
        its bin dir; that dir must be discoverable or those fail to start. We
        also add each bin dir's sibling `lib/`: the unified xtensa-esp-elf
        toolchain's per-chip config (`-mdynconfig=xtensa_esp32s3.so`) is a DLL in
        lib/ whose own dependencies the loader resolves via PATH.
        """
        dirs: list[str] = []
        for tool in (self.cc, self.ld, self.objcopy, self.objdump, self.nm):
            if not tool:
                continue
            d = os.path.dirname(tool)
            if d and d not in dirs:
                dirs.append(d)
            sib_lib = os.path.join(os.path.dirname(d), "lib") if d else ""
            if sib_lib and os.path.isdir(sib_lib) and sib_lib not in dirs:
                dirs.append(sib_lib)
        env = os.environ.copy()
        if dirs:
            env["PATH"] = os.pathsep.join((*dirs, env.get("PATH", "")))
        return env


def compile_module(
    tc: Toolchain,
    source: str | os.PathLike[str],
    arch: Arch,
    *,
    load_addr: int | None = None,
    include_dirs: tuple[str, ...] = (),
    ld_script: str | os.PathLike[str] | None = None,
    extra_cflags: tuple[str, ...] = (),
    dynconfig: str | None = None,
    verbose: bool = False,
) -> FwModule:
    """Compile a single C source into a FwModule: object -> linked image at the
    fixed base -> flat binary, with entry offset and .bss size read back.

    `dynconfig` selects the unified xtensa-esp-elf toolchain's per-chip core
    config (e.g. "xtensa_esp32s3.so"): it is resolved to a full path and exported
    as XTENSA_GNU_CONFIG, which drives gcc, the assembler, AND ld together —
    selecting the ESP32-S3 ISA and its little-endian byte order (the toolchain
    defaults to big-endian without it). Chip-specific toolchains bake this in and
    need no dynconfig."""
    src = Path(source)
    if not src.exists():
        raise ToolchainError(f"source not found: {src}")
    if load_addr is None:
        load_addr = DEFAULT_LOAD_ADDR.get(arch, 0)
    load_addr &= 0xFFFFFFFF

    env = tc.subprocess_env()
    if dynconfig:
        env["XTENSA_GNU_CONFIG"] = _resolve_dynconfig(tc, dynconfig)
    workdir = Path(tempfile.mkdtemp(prefix="fwmod-"))
    try:
        obj = workdir / "module.o"
        cflags = list(_CFLAGS)
        cflags += _ARCH_CFLAGS.get(arch, [])
        for inc in include_dirs:
            cflags += ["-I", str(inc)]
        cflags += list(extra_cflags)
        _run([tc.cc, "-c", *cflags, str(src), "-o", str(obj)], verbose, env=env)

        linked = workdir / "module.linked"
        # The entry point is set by the script's ENTRY(fw_main) and kept via
        # KEEP() (the gc root) — no -e needed, and that avoids an unresolved
        # reference to the undecorated name on targets that decorate it.
        ld_args = [
            tc.ld,
            "--gc-sections",
            f"--defsym=fw_dyn_base={load_addr}",
        ]
        if ld_script is not None:
            ld_args += ["-T", str(ld_script)]
        ld_args += [str(obj), "-o", str(linked)]
        _run(ld_args, verbose, env=env)

        flat = workdir / "module.bin"
        _run([tc.objcopy, "-O", "binary", str(linked), str(flat)], verbose, env=env)
        payload = flat.read_bytes()
        if not payload:
            raise ToolchainError(
                "objcopy produced an empty binary — the linker likely placed no "
                "loadable sections at the expected base (check the linker script)"
            )

        entry_offset = _entry_offset(tc, linked, load_addr, verbose, env)
        bss_size = _bss_size(tc, linked, verbose, env)

        return FwModule(
            payload=payload,
            arch=arch,
            entry_offset=entry_offset,
            bss_size=bss_size,
            load_addr=load_addr,
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _entry_offset(
    tc: Toolchain, linked: Path, load_addr: int, verbose: bool, env: dict[str, str]
) -> int:
    """fw_main's offset within the flat binary = its linked address minus the
    section base (== load_addr, set by the linker script). Returns 0 when nm is
    absent or fails (can't verify; the script forces fw_main first). Raises if nm
    runs but finds no defined fw_main (a missing/misspelled entry point)."""
    if not tc.nm:
        return 0
    try:
        out = _run([tc.nm, str(linked)], verbose, capture=True, env=env)
    except ToolchainError:
        return 0
    # The defined symbol is fw_main on ELF and _fw_main on i386 PE/COFF; match
    # both. (The undefined "U fw_main" line has no address column, so a length
    # check keeps it out.)
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[-1] in ("fw_main", "_fw_main"):
            try:
                off = int(parts[0], 16) - load_addr
            except ValueError:
                return 0
            return off if 0 <= off <= 0xFFFFFFFF else 0
    # nm ran and found no defined fw_main: the module has no entry point (missing
    # or misspelled). Fail loudly rather than emit a 'valid' module whose
    # entry_offset 0 points at whatever else survived the link.
    raise ToolchainError(
        "linked image defines no fw_main symbol — the module's entry point is "
        "missing or misspelled (expected `const fw_module_t *fw_main(const fw_api_t *)`)"
    )


def _bss_size(
    tc: Toolchain, linked: Path, verbose: bool, env: dict[str, str]
) -> int:
    """Sum of .bss* section sizes (zero-init RAM not present in the flat image)."""
    if not tc.objdump:
        return 0
    try:
        out = _run([tc.objdump, "-h", str(linked)], verbose, capture=True, env=env)
    except ToolchainError:
        return 0
    total = 0
    for line in out.splitlines():
        parts = line.split()
        # Section line: idx name size vma lma fileoff algn
        if len(parts) >= 7 and parts[1].startswith(".bss"):
            try:
                total += int(parts[2], 16)
            except ValueError:
                pass
    return total & 0xFFFFFFFF


def _run(
    cmd: list[str],
    verbose: bool,
    capture: bool = False,
    env: dict[str, str] | None = None,
) -> str:
    if verbose:
        print("  $ " + " ".join(cmd))
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
    except FileNotFoundError as e:
        raise ToolchainError(f"cannot run {cmd[0]!r}: {e}") from e
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise ToolchainError(
            f"command failed (exit {proc.returncode}): {' '.join(cmd)}\n{detail}"
        )
    # Surface warnings (compiler -W..., ld diagnostics) under -v; they exit 0
    # and would otherwise be swallowed.
    if verbose and proc.stderr.strip():
        print(proc.stderr.rstrip())
    return proc.stdout


def _resolve_dynconfig(tc: Toolchain, dynconfig: str) -> str:
    """Resolve a dynconfig to an absolute path: an existing path is used as-is;
    a bare name (xtensa_esp32s3.so) is looked up in each tool's sibling lib/."""
    if Path(dynconfig).exists():
        return str(Path(dynconfig).resolve())
    seen: list[str] = []
    for tool in (tc.cc, tc.ld):
        if not tool:
            continue
        bindir = os.path.dirname(tool)
        lib = os.path.join(os.path.dirname(bindir), "lib")
        if lib in seen:
            continue
        seen.append(lib)
        cand = os.path.join(lib, dynconfig)
        if os.path.exists(cand):
            return cand
    raise ToolchainError(
        f"dynconfig {dynconfig!r} not found (looked in: {', '.join(seen) or 'no lib dirs'}). "
        "Pass a full path or check the toolchain layout."
    )


def _missing_message(missing: list[str], prefix: str, bindir: str | None) -> str:
    names = ", ".join(f"{prefix}{m}" for m in missing)
    lines = [f"toolchain not found: {names}"]
    if prefix.startswith("xtensa"):
        lines.append(
            "Install ESP-IDF and `. ./export.sh` so xtensa-esp32s3-elf-gcc is on PATH, "
            "or pass --toolchain-dir <esp toolchain bin>."
        )
    else:
        lines.append(
            "Install a C toolchain (gcc + binutils) and ensure it is on PATH, "
            "or pass --toolchain-dir <bin> / --cc <path-to-gcc>."
        )
    return "\n".join(lines)


# ---- wasm32 build path (clang + wasm-ld) -----------------------------------
# A distinct pipeline from the gcc/ld/objcopy flat-binary path: clang targets
# wasm32, wasm-ld produces the module, and the .wasm IS the .fwmod payload (no
# fixed-base link or objcopy). Verified once an LLVM toolchain is installed; the
# runtime ABI it targets is already exercised by examples/hello-wasm.wat and the
# WasmModuleRuntime tests, and fw_api.h's __wasm__ branch maps the C calls to it.

_WASM_CFLAGS = [
    "-Os",
    "-nostdlib",
    "-ffreestanding",
    "-fno-builtin",
    "-Wall",
    "-Wextra",
]
# --no-entry: a freestanding module, no _start. --export-table: expose
# __indirect_function_table so the host can call the function pointers fw_main
# returns. (fw_main is exported via its export_name attribute in fw_api.h, and
# memory is exported by wasm-ld by default.)
_WASM_LDFLAGS = ["-Wl,--no-entry", "-Wl,--export-table"]


def find_clang(cc: str | None = None, bindir: str | None = None) -> str:
    """Locate clang for the wasm32 build: explicit --cc, then <bindir>/clang,
    then clang on PATH."""
    if cc:
        if Path(cc).exists() or shutil.which(cc):
            return cc
        raise ToolchainError(f"clang not found at {cc!r}")
    if bindir:
        for ext in (".exe", "") if os.name == "nt" else ("",):
            p = Path(bindir) / f"clang{ext}"
            if p.exists():
                return str(p)
    found = shutil.which("clang")
    if not found:
        raise ToolchainError(
            "clang not found. Install LLVM (clang + wasm-ld) and put it on PATH, "
            "or pass --cc <path-to-clang> / --toolchain-dir <llvm bin>."
        )
    return found


def compile_wasm_module(
    clang: str,
    source: str | os.PathLike[str],
    *,
    include_dirs: tuple[str, ...] = (),
    extra_cflags: tuple[str, ...] = (),
    verbose: bool = False,
) -> FwModule:
    """Compile a C source to a wasm32 module; the .wasm becomes the payload."""
    src = Path(source)
    if not src.exists():
        raise ToolchainError(f"source not found: {src}")

    # clang spawns wasm-ld from its own bin dir; keep that discoverable when
    # clang is invoked by absolute path off PATH.
    env = os.environ.copy()
    clang_dir = os.path.dirname(clang)
    if clang_dir:
        env["PATH"] = os.pathsep.join((clang_dir, env.get("PATH", "")))

    workdir = Path(tempfile.mkdtemp(prefix="fwmod-wasm-"))
    try:
        out = workdir / "module.wasm"
        args = [clang, "--target=wasm32", *_WASM_CFLAGS, *_WASM_LDFLAGS]
        for inc in include_dirs:
            args += ["-I", str(inc)]
        args += list(extra_cflags) + [str(src), "-o", str(out)]
        _run(args, verbose, env=env)
        payload = out.read_bytes()
        if not payload:
            raise ToolchainError("clang produced an empty .wasm")
        return FwModule(
            payload=payload, arch=Arch.WASM32, entry_offset=0, bss_size=0, load_addr=0
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
