/**
 * End-to-end guard: the files on disk under scenarios/ must be exactly what
 * the generator produces and must satisfy the loader checks.
 *
 * Skips (rather than fails) when scenarios/ has not been generated yet, so a
 * fresh clone can still run `pnpm --filter @kitchensched/scen test`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { PublicConfig } from "@kitchensched/contracts";

import { generateScenario, PRACTICE_SEED } from "../src/cli.js";
import { KITCHENS } from "../src/kitchens.js";
import type { OrderStreamFile } from "../src/stream.js";
import { validateOrderStream, validatePublicConfig } from "../src/validate.js";

const SCENARIOS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "scenarios");

function readIfPresent<T>(relativePath: string): T | null {
  const full = join(SCENARIOS_DIR, relativePath);
  if (!existsSync(full)) return null;
  return JSON.parse(readFileSync(full, "utf8")) as T;
}

describe("generated scenarios on disk", () => {
  const mediumKitchen = readIfPresent<PublicConfig>("medium/kitchen.json");
  const mediumStream = readIfPresent<OrderStreamFile>("medium/practice-stream.json");
  const easyKitchen = readIfPresent<PublicConfig>("easy/kitchen.json");
  const easyStream = readIfPresent<OrderStreamFile>("easy/practice-stream.json");

  const allPresent =
    mediumKitchen !== null && mediumStream !== null && easyKitchen !== null && easyStream !== null;

  it.skipIf(!allPresent)("medium kitchen.json passes the loader", () => {
    expect(validatePublicConfig(mediumKitchen)).toEqual([]);
  });

  it.skipIf(!allPresent)("easy kitchen.json passes the loader", () => {
    expect(validatePublicConfig(easyKitchen)).toEqual([]);
  });

  it.skipIf(!allPresent)("medium practice-stream.json passes the loader", () => {
    expect(validateOrderStream(mediumKitchen!, mediumStream)).toEqual([]);
  });

  it.skipIf(!allPresent)("easy practice-stream.json passes the loader", () => {
    expect(validateOrderStream(easyKitchen!, easyStream)).toEqual([]);
  });

  it.skipIf(!allPresent)("on-disk bytes match a fresh generation with the same seed", () => {
    for (const kitchen of KITCHENS) {
      const written = generateScenario(kitchen, SCENARIOS_DIR, PRACTICE_SEED);
      const kitchenPath = join(SCENARIOS_DIR, kitchen.calibration.difficulty, "kitchen.json");
      const streamPath = join(SCENARIOS_DIR, kitchen.calibration.difficulty, "practice-stream.json");
      expect(JSON.parse(readFileSync(kitchenPath, "utf8"))).toEqual(written.config);
      expect(JSON.parse(readFileSync(streamPath, "utf8"))).toEqual(written.stream);
    }
  });
});
