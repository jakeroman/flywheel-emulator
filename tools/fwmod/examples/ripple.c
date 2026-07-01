/*
 * ripple.c - a Flywheel accelerator that renders a full-screen animated effect.
 *
 * The point of the demo: computing an effect over all 400x240 = 96000 pixels
 * every frame is exactly the kind of tight loop Lua is slow at and C is fast at.
 * The Lua game just allocates a buffer, calls render() each frame, and blits the
 * result — all the per-pixel math happens here in C.
 *
 *   python -m fwmod build examples/ripple.c --arch wasm32 --cc <clang> -o ripple.fwmod
 */
#include "fw_api.h"

static const fw_api_t *FW;

/*
 * Fill a w*h, 1-byte-per-pixel buffer with expanding concentric rings from the
 * center, phase-advanced by t so the rings sweep outward. A second scrolling
 * band is XOR'd in for a moire shimmer. Pure integer math (no libm) — 1 = dark.
 * Returns the number of bytes written.
 */
static int32_t render(int32_t ptr, int32_t w, int32_t h, int32_t t) {
    unsigned char *buf = (unsigned char *)(unsigned)ptr;
    int32_t cx = w / 2;
    int32_t cy = h / 2;
    for (int32_t y = 0; y < h; y++) {
        int32_t dy = y - cy;
        int32_t dy2 = dy * dy;
        unsigned char *row = buf + (int32_t)(y * w);
        for (int32_t x = 0; x < w; x++) {
            int32_t dx = x - cx;
            int32_t r2 = dx * dx + dy2;         /* squared radius */
            int32_t rings = (((r2 >> 6) - t) & 8) ? 1 : 0;
            int32_t band = (((x + y + t) & 16) ? 1 : 0); /* diagonal scroll */
            row[x] = (unsigned char)(rings ^ band);
        }
    }
    return w * h;
}

static const fw_export_t EXPORTS[] = {
    {"render", render},
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
