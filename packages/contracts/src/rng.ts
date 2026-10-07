import type { Rng } from "./controller.js";

/**
 * mulberry32 — tiny deterministic PRNG shared by host, kernel-side
 * tooling, and candidates. Same seed → identical sequence everywhere
 * (Node CI, browser Worker, local dev).
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
