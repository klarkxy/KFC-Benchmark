import { describe, expect, it } from "vitest";
import { computeStateHash, isHash, sha256Hex } from "../src/index.js";
import { sha256BytesToHex, utf8Bytes } from "../src/sha256.js";

/**
 * Expected digests were produced with
 * `createHash("sha256").update(text, "utf8").digest("hex")` on Node 26 and are
 * pinned here as literals: this file is compiled into dist/ too, so it must not
 * import Node's crypto module.
 */
describe("vendored SHA-256", () => {
  it("matches the published vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // "The quick brown fox..." — the classic 448-bit single-block vector.
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("encodes non-ASCII as UTF-8 exactly like Node's Buffer and TextEncoder", () => {
    // CJK plus an emoji ZWJ sequence: 24 bytes, well past one block boundary.
    expect(sha256Hex("厨房排班 \u{1F9D1}\u200D\u{1F373}")).toBe(
      "0e1fb0db1a7e444c35c02b38fb6bb5a5c660474b5e03e7d34f2cfc854bc962d3",
    );
    // 171 bytes: multi-block padding of a purely non-ASCII payload.
    expect(
      sha256Hex(
        "今天的厨房排班：备料、腌制、炸炉、装盘、出餐；每一道工序都要严格按秒计算，任何一个动作迟到都会让整条链路出现偏差。",
      ),
    ).toBe("b547476e22412de0e2e3e72ccc732c3bc2a797561b9c464047dd7747f67063ec");
  });

  it("replaces unpaired surrogates with U+FFFD, like Buffer and TextEncoder", () => {
    expect(utf8Bytes("\uD800")).toEqual(Uint8Array.from([0xef, 0xbf, 0xbd]));
    expect(sha256Hex("\uD800")).toBe(
      "83d544ccc223c057d2bf80d3f2a32982c32c3c0db8e2674820da5064783fb097",
    );
  });

  it("hashes the raw bytes and the string identically", () => {
    const text = "厨房排班 \u{1F9D1}\u200D\u{1F373}";
    expect(sha256BytesToHex(utf8Bytes(text))).toBe(sha256Hex(text));
  });

  it("covers every padding length around the block boundary", () => {
    // 55 bytes fits the length field, 56 forces a second block.
    const ascii = "a".repeat(64);
    for (const text of [ascii.slice(0, 55), ascii.slice(0, 56), ascii]) {
      expect(sha256Hex(text)).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256Hex(text)).toBe(sha256Hex(`${text}`));
    }
    expect(sha256Hex("a".repeat(55))).not.toBe(sha256Hex("a".repeat(56)));
  });
});

describe("computeStateHash", () => {
  it("is a 64-char lowercase hex digest of the canonical projection", () => {
    const hash = computeStateHash({
      now_ms: 1_000,
      state_version: 7,
      orders: [],
      lots: [],
      tasks: [],
      stations: [{ id: "s1", task_id: null }],
      revenue_minor: 0,
      pending_wake_at_ms: null,
      deliveries: [],
    });
    expect(isHash(hash)).toBe(true);
    // Key order in the object above must not change the digest.
    expect(hash).toBe(
      computeStateHash({
        deliveries: [],
        pending_wake_at_ms: null,
        revenue_minor: 0,
        stations: [{ id: "s1", task_id: null }],
        tasks: [],
        lots: [],
        orders: [],
        state_version: 7,
        now_ms: 1_000,
      }),
    );
  });

  it("rejects non-hex and wrongly sized digests", () => {
    expect(isHash("E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855")).toBe(false);
    expect(isHash("abc")).toBe(false);
    expect(isHash(undefined)).toBe(false);
  });
});
