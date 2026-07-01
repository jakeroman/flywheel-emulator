/*
 * fw_api.h - Flywheel native module ABI (v1).
 *
 * A native module is freestanding C compiled to a flat binary (.fwmod) that the
 * BIOS loads into a fixed dynamic region of RAM. The module never links host
 * symbols directly; instead the host hands it a pointer to this jump table at
 * entry, and the module calls back through it. This struct's field order IS the
 * ABI: appending entries is backward compatible (bump FW_ABI_VERSION);
 * reordering or changing an existing entry is a breaking change.
 *
 * The surface mirrors the Lua `fw` API
 * (packages/emulator-core/src/lua/flywheel-api.ts) so a C module and a Lua app
 * are written against the same device contract. The Menu button is reserved by
 * the BIOS and is intentionally absent here.
 *
 * See docs/module-abi.md and docs/fwmod-format.md.
 */
#ifndef FW_API_H
#define FW_API_H

#include <stdint.h>
#include <stdbool.h>

#define FW_ABI_VERSION 1u

/* Display size, fixed by the panel (400x240 Sharp memory LCD). */
#define FW_SCREEN_W 400
#define FW_SCREEN_H 240

/* Button ids for btn()/btnp(). Menu is reserved by the BIOS (not exposed). */
typedef enum {
    FW_BTN_UP = 0,
    FW_BTN_DOWN = 1,
    FW_BTN_LEFT = 2,
    FW_BTN_RIGHT = 3,
    FW_BTN_A = 4,
    FW_BTN_B = 5,
    FW_BTN_SELECT = 6
} fw_button_t;

/*
 * The host jump table. The pointer is handed to the module at entry and is
 * valid for the module's lifetime. `on` selects dark ink (true) vs the light
 * reflective ground (false), matching the display's "on = dark pixel" model.
 */
typedef struct fw_api {
    uint32_t abi_version; /* equals FW_ABI_VERSION; the module should check it */
    int32_t width;        /* FW_SCREEN_W */
    int32_t height;       /* FW_SCREEN_H */

    /* ---- input ---- */
    bool (*btn)(int32_t button);  /* held this frame */
    bool (*btnp)(int32_t button); /* rising edge this frame */

    /* ---- graphics ---- */
    void (*cls)(bool on);
    void (*pixel)(int32_t x, int32_t y, bool on);
    void (*line)(int32_t x0, int32_t y0, int32_t x1, int32_t y1, bool on);
    void (*rect)(int32_t x, int32_t y, int32_t w, int32_t h, bool on);
    void (*rectfill)(int32_t x, int32_t y, int32_t w, int32_t h, bool on);
    void (*circle)(int32_t x, int32_t y, int32_t r, bool on);
    void (*circfill)(int32_t x, int32_t y, int32_t r, bool on);
    void (*print)(const char *s, int32_t x, int32_t y, bool on);
    int32_t (*text_width)(const char *s);

    /* ---- filesystem (resident SD, synchronous) ---- */
    /* Read up to `cap` bytes of `path` into `buf`; returns bytes read or -1. */
    int32_t (*fs_read)(const char *path, char *buf, int32_t cap);
    /* Write `len` bytes to `path` (overwrites); returns 0 or -1. */
    int32_t (*fs_write)(const char *path, const char *data, int32_t len);
    bool (*fs_exists)(const char *path);

    /* ---- sound ---- */
    void (*tone)(int32_t freq_hz, int32_t dur_ms);

    /* ---- misc ---- */
    uint32_t (*time_ms)(void);    /* ms since the module loaded */
    void (*log)(const char *msg); /* write to the dev console */
} fw_api_t;

/*
 * Accelerator exports (optional). Beyond the game lifecycle, a module may expose
 * named functions that a Lua game (or another module) calls directly through the
 * bridge — the "C-accelerated helper" model. Every export shares one uniform
 * signature: up to four 32-bit args, one 32-bit result. Pass a buffer as a
 * pointer + length (the bridge hands out a region of the module's own memory
 * that both sides read/write — a bare pointer on real hardware, a window into
 * the wasm/Xtensa sandbox in the emulator); pass a float as its raw bits.
 */
typedef int32_t (*fw_fn_t)(int32_t a0, int32_t a1, int32_t a2, int32_t a3);

typedef struct fw_export {
    const char *name; /* NULL terminates the array */
    fw_fn_t fn;
} fw_export_t;

/*
 * Module callbacks, mirroring the Lua _init/_update/_draw lifecycle. The module
 * returns a pointer to a (typically static) instance of this from fw_main.
 * `exports` is optional: NULL for a plain game, or a {NULL,NULL}-terminated
 * array of named accelerator functions. (Appending this field is backward
 * compatible; the host reads it only when present and bounds-checks the pointer.)
 */
typedef struct fw_module {
    void (*init)(void);
    void (*update)(float dt_seconds);
    void (*draw)(void);
    const fw_export_t *exports;
} fw_module_t;

/*
 * THE module entry point. Exactly one per module. The toolchain places it at
 * `entry_offset` in the flat binary (offset 0 with the provided linker script).
 * The host calls it once after loading, passing the jump table; the module
 * stashes `api`, wires up its callbacks, and returns them. Returning NULL
 * signals a failed init.
 */
const fw_module_t *fw_main(const fw_api_t *api);

/*
 * wasm32 bridge (Phase 5 dev/in-browser backend).
 *
 * On a wasm target the host can't hand the module a struct of host function
 * pointers, so each fw_api call is a wasm IMPORT from module "env" (names match
 * the runtime's WasmModuleRuntime env object). We build a static fw_api_t from
 * those imports and expose the SAME fw_main(api) contract: the user's fw_main is
 * renamed and an exported wrapper calls it with the static table, so one .c
 * compiles unchanged for both native (Xtensa/host) and wasm targets.
 *
 * NOTE: the C-side mapping is verified once an LLVM toolchain (clang + wasm-ld)
 * is available; the runtime ABI it targets is already exercised end-to-end by
 * examples/hello-wasm.wat + the WasmModuleRuntime tests.
 */
#ifdef __wasm__
#define FW_IMPORT(n) __attribute__((import_module("env"), import_name(#n)))

FW_IMPORT(btn) bool __fwi_btn(int32_t);
FW_IMPORT(btnp) bool __fwi_btnp(int32_t);
FW_IMPORT(cls) void __fwi_cls(bool);
FW_IMPORT(pixel) void __fwi_pixel(int32_t, int32_t, bool);
FW_IMPORT(line) void __fwi_line(int32_t, int32_t, int32_t, int32_t, bool);
FW_IMPORT(rect) void __fwi_rect(int32_t, int32_t, int32_t, int32_t, bool);
FW_IMPORT(rectfill) void __fwi_rectfill(int32_t, int32_t, int32_t, int32_t, bool);
FW_IMPORT(circle) void __fwi_circle(int32_t, int32_t, int32_t, bool);
FW_IMPORT(circfill) void __fwi_circfill(int32_t, int32_t, int32_t, bool);
FW_IMPORT(print) void __fwi_print(const char *, int32_t, int32_t, bool);
FW_IMPORT(text_width) int32_t __fwi_text_width(const char *);
FW_IMPORT(fs_read) int32_t __fwi_fs_read(const char *, char *, int32_t);
FW_IMPORT(fs_write) int32_t __fwi_fs_write(const char *, const char *, int32_t);
FW_IMPORT(fs_exists) bool __fwi_fs_exists(const char *);
FW_IMPORT(tone) void __fwi_tone(int32_t, int32_t);
FW_IMPORT(time_ms) uint32_t __fwi_time_ms(void);
FW_IMPORT(log) void __fwi_log(const char *);

static const fw_api_t __fw_table = {
    FW_ABI_VERSION, FW_SCREEN_W, FW_SCREEN_H,
    __fwi_btn, __fwi_btnp,
    __fwi_cls, __fwi_pixel, __fwi_line, __fwi_rect, __fwi_rectfill,
    __fwi_circle, __fwi_circfill, __fwi_print, __fwi_text_width,
    __fwi_fs_read, __fwi_fs_write, __fwi_fs_exists,
    __fwi_tone, __fwi_time_ms, __fwi_log};

/* The user's fw_main is renamed; the exported wrapper feeds it the static
 * table. The host calls the export "fw_main" with a dummy arg. */
#define fw_main __fw_user_main
const fw_module_t *__fw_user_main(const fw_api_t *api);

__attribute__((export_name("fw_main"))) const fw_module_t *__fw_entry(
    const fw_api_t *ignored) {
    (void)ignored;
    return __fw_user_main(&__fw_table);
}
#endif /* __wasm__ */

#endif /* FW_API_H */
