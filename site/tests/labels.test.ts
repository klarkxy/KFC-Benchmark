import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PublicConfig } from "@kitchensched/contracts";

import { itemLabel, recipeLabel, stationLabel } from "../src/lib/labels";

/**
 * Every id a scenario can put on screen must have a display label.
 *
 * `labels.ts` silently falls back to the raw id, so a missing entry does not
 * crash — it just leaks `it.baked_bun×1` into the play UI and misleads the
 * player about the production chain. This test reads the real scenario
 * configs so that adding a scenario (or an item to one) fails the suite until
 * its ids are labeled.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TIERS = ["easy", "medium"] as const;

function kitchen(tier: string): PublicConfig {
  const path = join(REPO_ROOT, "scenarios", tier, "kitchen.json");
  return JSON.parse(readFileSync(path, "utf8")) as PublicConfig;
}

/** Ids that render as themselves (or as nothing) — i.e. missing labels. */
function unlabeled(config: PublicConfig): string[] {
  const gaps: string[] = [];
  const check = (rendered: string, id: string): void => {
    if (rendered === id || rendered.trim().length === 0) gaps.push(id);
  };
  for (const item of config.items) check(itemLabel(item.id), item.id);
  for (const recipe of config.recipes) check(recipeLabel(recipe.id), recipe.id);
  for (const station of config.stations) check(stationLabel(station.id), station.id);
  return gaps;
}

describe("scenario label coverage", () => {
  for (const tier of TIERS) {
    it(`scenarios/${tier} labels every item, recipe and station`, () => {
      expect(unlabeled(kitchen(tier))).toEqual([]);
    });
  }
});
