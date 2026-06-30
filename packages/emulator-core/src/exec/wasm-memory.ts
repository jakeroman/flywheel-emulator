/**
 * Bounds-checked access to a guest's linear memory.
 *
 * Native modules pass `const char *` / buffers as integer offsets into their
 * memory (a wasm WebAssembly.Memory, or the Xtensa interpreter's RAM arena).
 * The `*At` core functions work over any Uint8Array view: every access (a) is
 * clamped to the buffer length, since the offset/length come from untrusted
 * guest code, and (b) treats the pointer as an unsigned i32. Callers that wrap a
 * growable wasm memory must re-read `memory.buffer` each call (growth detaches
 * the old ArrayBuffer) — the WebAssembly.Memory wrappers below do that.
 */

const MAX_STRING = 64 * 1024;

/** Read a NUL-terminated UTF-8 string at index `ptr` in `bytes`. Stops at the
 *  first NUL or after `maxLen` bytes; never reads past the buffer. */
export function readCStringAt(
  bytes: Uint8Array,
  ptr: number,
  maxLen = MAX_STRING,
): string {
  ptr = ptr >>> 0;
  if (ptr >= bytes.length) return "";
  const limit = Math.min(bytes.length, ptr + Math.max(0, maxLen));
  let end = ptr;
  while (end < limit && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(ptr, end));
}

/** Read `len` bytes at index `ptr`, clamped to the buffer (returns a copy). */
export function readBytesAt(
  bytes: Uint8Array,
  ptr: number,
  len: number,
): Uint8Array {
  ptr = ptr >>> 0;
  if (ptr >= bytes.length || len <= 0) return new Uint8Array(0);
  return bytes.slice(ptr, Math.min(bytes.length, ptr + len));
}

/** Write up to `cap` bytes of `data` at index `ptr`, clamped; returns the count. */
export function writeBytesAt(
  bytes: Uint8Array,
  ptr: number,
  data: Uint8Array,
  cap: number,
): number {
  ptr = ptr >>> 0;
  if (ptr >= bytes.length || cap <= 0) return 0;
  const n = Math.min(data.length, cap, bytes.length - ptr);
  bytes.set(data.subarray(0, n), ptr);
  return n;
}

// ---- WebAssembly.Memory wrappers (offset 0 is treated as a null pointer) ----

export function readCString(
  memory: WebAssembly.Memory,
  ptr: number,
  maxLen = MAX_STRING,
): string {
  if ((ptr >>> 0) === 0) return "";
  return readCStringAt(new Uint8Array(memory.buffer), ptr, maxLen);
}

export function readBytes(
  memory: WebAssembly.Memory,
  ptr: number,
  len: number,
): Uint8Array {
  return readBytesAt(new Uint8Array(memory.buffer), ptr, len);
}

export function writeBytes(
  memory: WebAssembly.Memory,
  ptr: number,
  data: Uint8Array,
  cap: number,
): number {
  return writeBytesAt(new Uint8Array(memory.buffer), ptr, data, cap);
}
