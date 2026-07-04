import "./ApiReference.css";

/**
 * The API Reference tab: an in-app, static reference for the `fw` API — the
 * contract Flywheel Lua games are written against. It mirrors the runtime
 * surface in packages/emulator-core/src/lua/flywheel-api.ts. Keep the two in
 * sync when the API changes (there is a doc-drift check in the review notes).
 */

interface Entry {
  sig: string;
  desc: string;
}

interface Group {
  id: string;
  title: string;
  blurb?: string;
  entries: Entry[];
  /** Optional example shown under the group. */
  example?: string;
}

const GROUPS: Group[] = [
  {
    id: "lifecycle",
    title: "Lifecycle",
    blurb:
      "A game defines these globals. The device calls them each frame: update() advances state, draw() renders. All three are optional.",
    entries: [
      { sig: "function _init()", desc: "Called once when the game loads." },
      {
        sig: "function _update(dt)",
        desc: "Called every frame. dt is seconds since the last frame.",
      },
      {
        sig: "function _draw()",
        desc: "Called every frame after _update. Draw the screen here.",
      },
      {
        sig: "fw.exit()",
        desc: "Quit back to the launcher. The canonical way a game ends — the system does a warm restart to the game selector. Save first (fw.save writes through immediately). Takes effect at the end of the frame.",
      },
    ],
    example: `local x = 0
function _update(dt) x = x + 60 * dt end
function _draw()
  fw.gfx.cls()
  fw.gfx.circfill(x % fw.width, 120, 6)
end`,
  },
  {
    id: "loop",
    title: "Main-loop mode",
    blurb:
      "Instead of callbacks, a game can own its loop: a top-level `while true` that draws a frame and calls fw.flip() to present it. It's auto-detected — if your script has such a loop, it runs as a coroutine that yields each frame (no callbacks needed). On hardware this is a frame-paced task on the app core: flip = push the panel over SPI, then wait for the next frame.",
    entries: [
      {
        sig: "fw.flip()",
        desc: "Present the current frame and hand control back until the next frame.",
      },
      {
        sig: "fw.gfx.refresh()",
        desc: "Same as fw.flip() in main-loop mode (present + yield).",
      },
      {
        sig: "fw.wait(seconds)",
        desc: "Pause for a duration, yielding each frame (doesn't block the system).",
      },
      {
        sig: "sleep(ms)",
        desc: "Pause for milliseconds (v1 alias for fw.wait).",
      },
      {
        sig: "fw.dt() → number",
        desc: "Seconds elapsed since the last frame (for your own movement math).",
      },
    ],
    example: `-- No _update/_draw — this game owns the loop.
local x = 0
while true do
  x = x + 60 * fw.dt()
  fw.gfx.cls()
  fw.gfx.circfill(x % fw.width, 120, 6)
  fw.flip()          -- present, resume next frame
end`,
  },
  {
    id: "display",
    title: "Display & input",
    blurb:
      "The panel is 400×240, 1-bit. Buttons are the D-pad, A, B, and Select. Menu is the system/home button by default — a press returns to the launcher — so it doesn't reach a game unless you claim it with fw.custom_menu_button(true).",
    entries: [
      { sig: "fw.width, fw.height", desc: "Screen size in pixels (400, 240)." },
      {
        sig: "fw.UP / DOWN / LEFT / RIGHT / A / B / SELECT",
        desc: "Button ids, passed to btn()/btnp().",
      },
      {
        sig: "fw.btn(id) → bool",
        desc: "True while the button is held this frame.",
      },
      {
        sig: "fw.btnp(id) → bool",
        desc: "True only on the frame the button goes down (rising edge).",
      },
      {
        sig: "fw.custom_menu_button(on)",
        desc: "Take over the Menu button. When on, Menu stops returning to the launcher and reaches the game as fw.MENU — you must then provide a way out (fw.exit() or the power switch). Off (default) hands it back.",
      },
      {
        sig: "fw.MENU",
        desc: "The Menu button id. Only readable via btn()/btnp() after fw.custom_menu_button(true).",
      },
    ],
  },
  {
    id: "gfx",
    title: "Graphics — fw.gfx",
    blurb:
      "The display is monochrome and bistable. Every draw op takes a fill (0..1): 0 = light (the reflective ground), 1 = dark (solid ink), and anything between is a gray shade via an ordered 4x4 Bayer pattern (0.5 = 50% checkerboard). fill defaults to 1 (dark) for shapes and text, and 0 (light) for cls. (true/false also work as 1/0.)",
    entries: [
      {
        sig: "fw.gfx.cls(fill?)",
        desc: "Clear the screen (default light; a fill shades it gray).",
      },
      { sig: "fw.gfx.pixel(x, y, fill?)", desc: "Set one pixel." },
      { sig: "fw.gfx.line(x0, y0, x1, y1, fill?)", desc: "Draw a line." },
      { sig: "fw.gfx.rect(x, y, w, h, fill?)", desc: "Outline a rectangle." },
      {
        sig: "fw.gfx.rectfill(x, y, w, h, fill?)",
        desc: "Fill a rectangle (fill 0.5 for gray).",
      },
      { sig: "fw.gfx.circle(x, y, r, fill?)", desc: "Outline a circle." },
      {
        sig: "fw.gfx.circfill(x, y, r, fill?)",
        desc: "Fill a circle (fill 0.5 for gray).",
      },
      {
        sig: "fw.gfx.print(text, x, y, fill?, scale?)",
        desc: "Draw text. scale is an integer ≥ 1 (2 = double size); fill shades it.",
      },
      {
        sig: "fw.gfx.text_width(text, scale?) → number",
        desc: "Pixel width of text at the given scale.",
      },
      {
        sig: "fw.gfx.blit(src, x, y, w, h)",
        desc: "Draw a w×h bitmap (1 byte/pixel, nonzero = dark). src is a byte array (best for bitmaps with off-pixels), a native buffer, or a NUL-free Lua string.",
      },
      {
        sig: "fw.gfx.refresh()",
        desc: "Present the frame to the panel. No-op in the emulator (it auto-presents after _draw); the real hardware push on device.",
      },
    ],
  },
  {
    id: "save",
    title: "Save data — fw.save",
    blurb:
      "A per-game key/value store that survives power-off and reloads. Each game only sees its own saves (scoped to a private folder under /saves). Values are any JSON-serializable data: numbers, strings, booleans, and tables of them.",
    entries: [
      {
        sig: "fw.save.get(key, default?) → value",
        desc: "Read a saved value, or default (nil if omitted) when unset.",
      },
      {
        sig: "fw.save.set(key, value)",
        desc: "Persist a value (writes through immediately). Setting nil clears the key.",
      },
      { sig: "fw.save.has(key) → bool", desc: "Whether the key is saved." },
      { sig: "fw.save.delete(key)", desc: "Remove one key." },
      { sig: "fw.save.keys() → table", desc: "List of saved key names." },
      { sig: "fw.save.clear()", desc: "Erase this game's entire save." },
      {
        sig: "fw.save.dir → string",
        desc: 'This game\'s save folder, e.g. "/saves/snake".',
      },
    ],
    example: `function _init()
  best = fw.save.get("best", 0)   -- 0 the first time ever
end

function _on_win(score)
  if score > best then
    best = score
    fw.save.set("best", best)     -- persists across reboots
  end
end`,
  },
  {
    id: "fs",
    title: "Files — fw.fs",
    blurb:
      "Raw, synchronous access to the whole SD card (POSIX-style absolute paths). Most games want fw.save instead; reach for fw.fs to read bundled assets or share files between games.",
    entries: [
      { sig: "fw.fs.read(path) → string", desc: "Read a file as text." },
      { sig: "fw.fs.write(path, data)", desc: "Write text (overwrites)." },
      { sig: "fw.fs.exists(path) → bool", desc: "Whether a path exists." },
      {
        sig: "fw.fs.list(path) → table",
        desc: "Directory entries: { name, path, type, size }.",
      },
      { sig: "fw.fs.mkdir(path)", desc: "Create a directory (recursive)." },
      { sig: "fw.fs.remove(path)", desc: "Delete a file or directory." },
      {
        sig: "fw.fs.stat(path) → table|nil",
        desc: "File info { name, path, type, size }, or nil.",
      },
      {
        sig: 'require("name")',
        desc: 'Load a sibling module: name.lua from the game\'s own folder ("sub/mod" works). Split a game across files.',
      },
    ],
  },
  {
    id: "misc",
    title: "Sound, time & log",
    entries: [
      {
        sig: "fw.sound.tone(hz, ms?)",
        desc: "Play a square-wave tone (ms defaults to 120).",
      },
      {
        sig: "fw.time() → number",
        desc: "Game time in seconds — a per-frame clock (constant within a frame).",
      },
      {
        sig: "fw.clock() → number",
        desc: "Real monotonic time in ms, for profiling (advances within a frame). Don't use it for game logic — it's non-deterministic.",
      },
      {
        sig: "fw.battery() → table",
        desc: "Read-only power state: { level 0..1, percent, charging, volts }.",
      },
      {
        sig: "fw.log(...)",
        desc: "Print to the dev console (arguments space-joined and stringified).",
      },
    ],
  },
  {
    id: "native",
    title: "Native modules — fw.native",
    blurb:
      "A game can declare C helpers (.fwmod) in its game.json; each appears as fw.native.<name>. A helper exposes its exported functions as direct calls plus alloc(n) for a shared buffer — the same code runs in the emulator and on real silicon.",
    entries: [
      {
        sig: "fw.native.<mod>.alloc(nbytes) → buffer",
        desc: "Reserve shared scratch memory in the module; returns a buffer.",
      },
      {
        sig: "fw.native.<mod>.<export>(...args) → number",
        desc: "Call a C export. A buffer arg marshals to its pointer.",
      },
      {
        sig: "buffer.get(i) / buffer.set(i, v)",
        desc: "Read / write one byte; buffer.bytes() copies it all out.",
      },
    ],
    example: `-- game.json: "modules": [{ "name": "fx", "path": "fx.fwmod" }]
local fx = fw.native.fx
local buf = fx.alloc(fw.width * fw.height)
function _draw()
  fx.render(buf, fw.width, fw.height, fw.time() * 60)
  fw.gfx.blit(buf, 0, 0, fw.width, fw.height)
end`,
  },
];

export function ApiReference() {
  return (
    <div className="fw-apiref" role="region" aria-label="API reference">
      <header className="fw-apiref__head">
        <h2 className="fw-apiref__title">API Reference</h2>
        <p className="fw-apiref__sub">
          The <code>fw</code> API — the contract every Flywheel game is written
          against. Available as a global in any Lua script.
        </p>
      </header>

      <nav className="fw-apiref__toc" aria-label="Sections">
        {GROUPS.map((g) => (
          <a key={g.id} href={`#apiref-${g.id}`} className="fw-apiref__tocitem">
            {g.title}
          </a>
        ))}
      </nav>

      {GROUPS.map((g) => (
        <section key={g.id} id={`apiref-${g.id}`} className="fw-apiref__group">
          <h3 className="fw-apiref__grouptitle">{g.title}</h3>
          {g.blurb && <p className="fw-apiref__blurb">{g.blurb}</p>}
          <dl className="fw-apiref__list">
            {g.entries.map((e) => (
              <div key={e.sig} className="fw-apiref__entry">
                <dt>
                  <code className="fw-apiref__sig">{e.sig}</code>
                </dt>
                <dd className="fw-apiref__desc">{e.desc}</dd>
              </div>
            ))}
          </dl>
          {g.example && (
            <pre className="fw-apiref__example">
              <code>{g.example}</code>
            </pre>
          )}
        </section>
      ))}

      <footer className="fw-apiref__foot">
        C modules are written against the same surface via <code>fw_api.h</code>{" "}
        (a jump table mirroring this API): graphics take the same{" "}
        <code>fill</code> (a <code>float</code> 0..1), and modules save with{" "}
        <code>fs_read</code> / <code>fs_write</code> directly. See{" "}
        <code>docs/module-abi.md</code>.
      </footer>
    </div>
  );
}
