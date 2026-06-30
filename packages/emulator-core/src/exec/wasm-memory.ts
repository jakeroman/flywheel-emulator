/**
 * Bounds-checked access to a wasm module's linear memory.
 *
 * Native modules pass `const char *` / buffers as i32 offsets into their
 * WebAssembly.Memory. Every host-side access must (a) re-read `memory.buffer`
 * each time, because growing the memory detaches the old ArrayBuffer, and
 * (b) clamp to the current byte length, because the offset/length come from
 * untrusted guest code. These helpers are the single chokepoint for both.
 */

const MAX_STRING = 64 * 1024;

/** Read a NUL-terminated UTF-8 string at `ptr`. Returns "" for a null/OOB ptr;
 *  stops at the first NUL or after `maxLen` bytes (guards an unterminated
 *  string), never reading past the buffer. */
export function readCString(
  memory: WebAssembly.Memory,
  ptr: number,
  maxLen = MAX_STRING,
): string {
  ptr = ptr >>> 0; // treat as unsigned i32 (also coerces NaN/float → integer)
  const bytes = new Uint8Array(memory.buffer);
  if (ptr === 0 || ptr >= bytes.length) return "";
  const limit = Math.min(bytes.length, ptr + Math.max(0, maxLen));
  let end = ptr;
  while (end < limit && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(ptr, end));
}

/** Read `len` bytes at `ptr`, clamped to the buffer. Returns a copy (safe to
 *  retain across a later memory.grow()). */
export function readBytes(
  memory: WebAssembly.Memory,
  ptr: number,
  len: number,
): Uint8Array {
  ptr = ptr >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  if (ptr >= bytes.length || len <= 0) return new Uint8Array(0);
  const end = Math.min(bytes.length, ptr + len);
  return bytes.slice(ptr, end);
}

/** Write up to `cap` bytes of `data` at `ptr`, clamped to the buffer. Returns
 *  the number of bytes actually written. */
export function writeBytes(
  memory: WebAssembly.Memory,
  ptr: number,
  data: Uint8Array,
  cap: number,
): number {
  ptr = ptr >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  if (ptr >= bytes.length || cap <= 0) return 0;
  const n = Math.min(data.length, cap, bytes.length - ptr);
  bytes.set(data.subarray(0, n), ptr);
  return n;
}
