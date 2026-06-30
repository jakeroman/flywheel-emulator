/*
 * dynregion.ld - link a Flywheel native module as a flat image whose code
 * begins at the fixed dynamic-region base.
 *
 * fw_main is forced to the front of the CODE so its entry offset is small and
 * stable. Compile units with -ffunction-sections so fw_main lands in its own
 * function section that this script can place first. The CLI then runs
 * `objcopy -O binary` to strip everything down to the loadable bytes, and reads
 * fw_main's real offset back from nm (it is NOT assumed to be 0 — see below).
 *
 * Xtensa L32R literal pools come first: an L32R can only reference a literal at
 * a LOWER address (its 16-bit word offset is always negative), so every
 * function's literals must precede the code that loads them. Lumping all
 * .literal sections at the very front guarantees this for the whole image; the
 * cost is that fw_main's entry offset is then the literal-pool size, not 0 (the
 * runtime reads entry_offset from the header, so that is fine). PE/COFF host
 * builds have no .literal sections, so there fw_main stays at offset 0.
 *
 * The base address is supplied by the CLI via `--defsym fw_dyn_base=ADDR`
 * (default below is a plausible ESP32-S3 internal-SRAM address; host/dev builds
 * just record whatever base they linked at in the .fwmod header).
 */
ENTRY(fw_main)

fw_dyn_base = DEFINED(fw_dyn_base) ? fw_dyn_base : 0x3FC88000;

SECTIONS {
    . = fw_dyn_base;

    /* Entry first => entry_offset 0. Function/data sections are named
     * differently on ELF (.text.fw_main, .rodata) and PE/COFF
     * (.text$fw_main, .rdata) — match both so one script serves the Xtensa
     * (ELF) and host MinGW (PE/COFF) toolchains. */
    .text : {
        /* L32R literals first (see header) — backward-only reach. */
        *(.literal .literal.*)
        KEEP(*(.text.fw_main))
        KEEP(*(.text$fw_main))
        *(.text .text.* .text$*)
        *(.rodata .rodata.* .rdata .rdata$*)
    }

    .data : {
        *(.data .data.* .data$*)
    }

    .bss (NOLOAD) : {
        *(.bss .bss.* .bss$* COMMON)
    }

    /DISCARD/ : {
        *(.comment)
        *(.note .note.*)
        *(.eh_frame .eh_frame_hdr)
        *(.drectve)
    }
}
