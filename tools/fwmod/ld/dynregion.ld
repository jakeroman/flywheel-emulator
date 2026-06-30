/*
 * dynregion.ld - link a Flywheel native module as a flat image whose code
 * begins at the fixed dynamic-region base.
 *
 * fw_main is forced to the very front so its entry offset within the flat
 * binary is 0. Compile units with -ffunction-sections so fw_main lands in its
 * own function section that this script can place first. The CLI then runs
 * `objcopy -O binary` to strip everything down to the loadable bytes.
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
