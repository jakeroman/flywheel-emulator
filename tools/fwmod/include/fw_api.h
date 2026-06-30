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
 * Module callbacks, mirroring the Lua _init/_update/_draw lifecycle. The module
 * returns a pointer to a (typically static) instance of this from fw_main.
 */
typedef struct fw_module {
    void (*init)(void);
    void (*update)(float dt_seconds);
    void (*draw)(void);
} fw_module_t;

/*
 * THE module entry point. Exactly one per module. The toolchain places it at
 * `entry_offset` in the flat binary (offset 0 with the provided linker script).
 * The host calls it once after loading, passing the jump table; the module
 * stashes `api`, wires up its callbacks, and returns them. Returning NULL
 * signals a failed init.
 */
const fw_module_t *fw_main(const fw_api_t *api);

#endif /* FW_API_H */
