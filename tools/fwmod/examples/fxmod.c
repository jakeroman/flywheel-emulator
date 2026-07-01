/*
 * fxmod.c - a Flywheel accelerator module (the "C helper called from Lua" model).
 *
 * It has no game loop worth speaking of; its value is the exported functions a
 * Lua game calls for hot-path work. Both take a buffer pointer the host handed
 * out (host-owned memory both sides share) and process it in tight C.
 *
 *   python -m fwmod build examples/fxmod.c --arch wasm32 --cc <clang> -o fxmod.fwmod
 */
#include "fw_api.h"

static const fw_api_t *FW;

/* Fill a w*h, 1-byte-per-cell buffer with a scrolling diagonal ramp. Returns
 * the number of bytes written. */
static int32_t shade(int32_t ptr, int32_t w, int32_t h, int32_t t) {
    unsigned char *buf = (unsigned char *)(unsigned)ptr;
    for (int32_t y = 0; y < h; y++) {
        for (int32_t x = 0; x < w; x++) {
            buf[y * w + x] = (unsigned char)((x + y + t) & 0xff);
        }
    }
    return w * h;
}

/* Sum `len` bytes of a buffer (a reduction Lua would be slow at). */
static int32_t sum(int32_t ptr, int32_t len, int32_t a2, int32_t a3) {
    (void)a2;
    (void)a3;
    const unsigned char *buf = (const unsigned char *)(unsigned)ptr;
    int32_t acc = 0;
    for (int32_t i = 0; i < len; i++) acc += buf[i];
    return acc;
}

static const fw_export_t EXPORTS[] = {
    {"shade", shade},
    {"sum", sum},
    {0, 0},
};

static void init(void) {}
static void update(float dt) { (void)dt; }
static void draw(void) {}

static const fw_module_t MODULE = {init, update, draw, EXPORTS};

const fw_module_t *fw_main(const fw_api_t *api) {
    FW = api;
    if (api->abi_version != FW_ABI_VERSION) return 0;
    return &MODULE;
}
