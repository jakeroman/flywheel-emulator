/**
 * CRC-32/ISO-HDLC — the zlib / IEEE-802.3 / PNG variant: reflected, polynomial
 * 0xEDB88320, init 0xFFFFFFFF, final XOR 0xFFFFFFFF. This matches Python's
 * `zlib.crc32`, so a `.fwmod` written by the Python CLI verifies here.
 *
 * Check vector: crc32(utf8 "123456789") === 0xCBF43926.
 */

const TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
