/**
 * Vendored SHA-256 (FIPS 180-4), dependency-free and synchronous.
 *
 * Why this exists: the state hash (doc 02 §11) must be byte-identical in the
 * Node host, in CI and in the browser game, and it is computed synchronously
 * inside the kernel. Node's crypto module cannot be imported in a browser
 * bundle and the WebCrypto digest is async-only, so the digest is implemented
 * here in plain TypeScript. The output is asserted against known vectors plus
 * Node-generated UTF-8 vectors in tests/sha256.test.ts.
 */

/** Round constants: first 32 bits of the fractional parts of cube roots. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** First 32 bits of the fractional parts of the square roots of the first 64 primes. */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const HEX = "0123456789abcdef";

/**
 * UTF-8 encodes a JS string, byte-for-byte identical to
 * `Buffer.from(text, "utf8")` and to `new TextEncoder().encode(text)`:
 * well-formed surrogate pairs become one 4-byte sequence, and every lone
 * surrogate (or any other unpaired code unit) becomes U+FFFD, exactly as both
 * Node and TextEncoder do.
 */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** SHA-256 digest of raw bytes, lowercase hex. */
export function sha256BytesToHex(bytes: Uint8Array): string {
  // Padded length: message + 0x80 + zeros to 56 mod 64 + 8-byte bit length.
  const blocks = Math.floor((bytes.length + 8) / 64) + 1;
  const padded = new Uint8Array(blocks * 64);
  padded.set(bytes, 0);
  padded[bytes.length] = 0x80;
  // Bit length as a 64-bit big-endian integer, split so lengths >= 2^29 bytes
  // (2^32 bits) stay exact.
  const bitLenHi = Math.floor(bytes.length / 0x20000000);
  const bitLenLo = (bytes.length * 8) >>> 0;
  const tail = padded.length - 8;
  padded[tail] = (bitLenHi >>> 24) & 0xff;
  padded[tail + 1] = (bitLenHi >>> 16) & 0xff;
  padded[tail + 2] = (bitLenHi >>> 8) & 0xff;
  padded[tail + 3] = bitLenHi & 0xff;
  padded[tail + 4] = (bitLenLo >>> 24) & 0xff;
  padded[tail + 5] = (bitLenLo >>> 16) & 0xff;
  padded[tail + 6] = (bitLenLo >>> 8) & 0xff;
  padded[tail + 7] = bitLenLo & 0xff;

  const h = new Uint32Array(H0);
  const w = new Uint32Array(64);
  for (let block = 0; block < blocks; block += 1) {
    const offset = block * 64;
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      w[i] =
        (((padded[at] ?? 0) << 24) |
          ((padded[at + 1] ?? 0) << 16) |
          ((padded[at + 2] ?? 0) << 8) |
          (padded[at + 3] ?? 0)) >>>
        0;
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }

    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;
    for (let i = 0; i < 64; i += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + s1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = ((h[0] as number) + a) >>> 0;
    h[1] = ((h[1] as number) + b) >>> 0;
    h[2] = ((h[2] as number) + c) >>> 0;
    h[3] = ((h[3] as number) + d) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0;
    h[5] = ((h[5] as number) + f) >>> 0;
    h[6] = ((h[6] as number) + g) >>> 0;
    h[7] = ((h[7] as number) + hh) >>> 0;
  }

  let hex = "";
  for (let i = 0; i < 8; i += 1) {
    const word = h[i] as number;
    for (let shift = 28; shift >= 0; shift -= 4) {
      hex += HEX[(word >>> shift) & 0xf];
    }
  }
  return hex;
}

function rotr(word: number, bits: number): number {
  return ((word >>> bits) | (word << (32 - bits))) >>> 0;
}

/** SHA-256 hex digest of the UTF-8 encoding of `text`. */
export function sha256Hex(text: string): string {
  return sha256BytesToHex(utf8Bytes(text));
}
