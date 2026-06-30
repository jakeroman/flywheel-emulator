/*
 * hello.c - a minimal Flywheel native module.
 *
 * Demonstrates the module ABI: stash the jump table in fw_main, then draw and
 * react to input through it. Build with:
 *
 *   python -m fwmod build examples/hello.c -o hello.fwmod
 */
#include "fw_api.h"

/* The host jump table, stashed at entry for the module's lifetime. */
static const fw_api_t *FW;

static int32_t ticks;

static void init(void) {
    ticks = 0;
}

static void update(float dt) {
    (void)dt;
    ticks++;
    if (FW->btnp(FW_BTN_A)) {
        FW->tone(440, 120);
        FW->log("beep");
    }
}

static void draw(void) {
    FW->cls(false);
    FW->rect(8, 8, FW->width - 16, FW->height - 16, true);
    FW->print("HELLO FROM C", 152, 112, true);

    /* A dot that sweeps across the top to show frames are advancing. */
    int32_t span = FW->width - 40;
    int32_t x = 20 + (ticks % span);
    FW->circfill(x, 40, 5, true);
}

static const fw_module_t MODULE = {init, update, draw};

const fw_module_t *fw_main(const fw_api_t *api) {
    FW = api;
    if (api->abi_version != FW_ABI_VERSION) {
        return 0; /* host ABI is newer/older than we were built against */
    }
    return &MODULE;
}
