import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PublicConfig } from "@kitchensched/contracts";

import { itemBadge, itemEmoji } from "../src/play/icons";

/**
 * A ticket is one small square per order line, so every line has to be
 * distinguishable at a glance. Emoji cannot carry that alone — three burgers
 * all want 🍔 — so each item also carries a badge (汉 / 汉双 / 汉三). These
 * tests read the real scenario configs so adding an item without art, or with
 * art that collides on the badge, fails the suite instead of shipping an
 * undecipherable ticket.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TIERS = ["easy", "medium"] as const;

function kitchen(tier: string): PublicConfig {
  const path = join(REPO_ROOT, "scenarios", tier, "kitchen.json");
  return JSON.parse(readFileSync(path, "utf8")) as PublicConfig;
}

function allItemIds(): string[] {
  const ids = new Set<string>();
  for (const tier of TIERS) {
    for (const item of kitchen(tier).items) ids.add(item.id);
  }
  return [...ids];
}

describe("item art", () => {
  const ids = allItemIds();

  it("covers every scenario item with an emoji and a badge", () => {
    const artless = ids.filter((id) => itemEmoji(id).trim().length === 0 || itemBadge(id).trim().length === 0);
    expect(artless).toEqual([]);
  });

  it("never falls back to the unknown-item glyph", () => {
    const generic = ids.filter((id) => itemEmoji(id) === "❓");
    expect(generic).toEqual([]);
  });

  it("gives every item a unique badge, so two lines on one ticket differ", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const id of ids) {
      const badge = itemBadge(id);
      const owner = seen.get(badge);
      if (owner !== undefined) collisions.push(`${badge}: ${owner} vs ${id}`);
      seen.set(badge, id);
    }
    expect(collisions).toEqual([]);
  });

  it("keeps the (emoji, badge) pair unique across scenarios", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const id of ids) {
      const key = `${itemEmoji(id)}|${itemBadge(id)}`;
      const owner = seen.get(key);
      if (owner !== undefined) collisions.push(`${key}: ${owner} vs ${id}`);
      seen.set(key, id);
    }
    expect(collisions).toEqual([]);
  });

  it("renders every line of the unreadable ticket distinguishably", () => {
    // o1 = crispy + combo + grilled, which used to render as 🥪1 🍱1 🥪1
    const lines = ["p.crispy_sandwich", "p.combo_box", "p.grilled_sandwich"];
    const rendered = lines.map((id) => `${itemEmoji(id)}${itemBadge(id)}`);
    expect(new Set(rendered).size).toBe(3);
    // and where an emoji still has to be shared, the badge carries it
    expect(itemEmoji("p.burger_double")).toBe(itemEmoji("p.burger_trio"));
    expect(itemBadge("p.burger_double")).not.toBe(itemBadge("p.burger_trio"));
  });
});
