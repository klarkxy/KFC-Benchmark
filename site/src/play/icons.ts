/**
 * Emoji art map for the play screens — no asset files, no icon font.
 *
 * Ids come from the scenario configs (`st.*`, `it.*`, `p.*`, `r.*`) plus the
 * older demo replay ids, so a station always looks like the thing it makes.
 * Unknown ids fall back to a generic glyph rather than a blank tile.
 */

import { itemLabel } from "../lib/labels";

const STATION_EMOJI: Readonly<Record<string, string>> = {
  prep_a: "🧊",
  prep_b: "🥔",
  fry_1: "🍟",
  fry_2: "🍟",
  assemble_1: "🥪",
  assemble_2: "🥪",

  "st.grill": "🍳",
  "st.fryer": "🍟",
  "st.oven": "🔥",
  "st.counter": "🥪",
  "st.packager": "📦",
  "st.marinator": "🧂",
  "st.breader": "🍞",
  "st.fryer_a": "🍟",
  "st.fryer_b": "🍟",
  "st.heater_a": "🔥",
  "st.heater_b": "🔥",
  "st.assembler": "🥪",
  "st.dispenser": "📦",
};

export const stationEmoji = (id: string): string => STATION_EMOJI[id] ?? "🍳";

const RECIPE_EMOJI: Readonly<Record<string, string>> = {
  r_fry: "🍟",
  r_patty: "🍗",
  r_burger: "🍔",
  r_cola: "🥤",

  "r.grill_chicken": "🍳",
  "r.fry_chicken": "🍗",
  "r.fry_fries": "🍟",
  "r.bake_bun": "🥖",
  "r.assemble_grilled": "🥪",
  "r.assemble_crispy": "🥪",
  "r.pack_grilled_sandwich": "🥪",
  "r.pack_crispy_sandwich": "🥪",
  "r.pack_fries_box": "🍟",
  "r.pack_combo_box": "🍱",
  "r.marinate": "🧂",
  "r.bread": "🍞",
  "r.fry_patty": "🍗",
  "r.heat_bun": "🥖",
  "r.heat_skin": "🫓",
  "r.portion_sauce": "🥣",
  "r.pour_drink": "🥤",
  "r.build_burger": "🍔",
  "r.build_wrap": "🌯",
  "r.pack_burger_classic": "🍔",
  "r.pack_burger_double": "🍔",
  "r.pack_burger_trio": "🍔",
  "r.pack_wrap_classic": "🌯",
  "r.pack_wrap_double": "🌯",
  "r.pack_fries": "🍟",
  "r.pack_meal_burger": "🍱",
  "r.pack_meal_wrap": "🍱",
};

export const recipeEmoji = (id: string): string => RECIPE_EMOJI[id] ?? "🍽️";

const ITEM_EMOJI: Readonly<Record<string, string>> = {
  raw_chicken: "🍗",
  raw_cola: "🥤",
  fries: "🍟",
  patty: "🍗",
  burger: "🍔",
  cola: "🥤",

  // easy
  "it.chicken_raw": "🍗",
  "it.dough_raw": "🧈",
  "it.fry_raw": "🧊",
  "it.chicken_grilled": "🍳",
  "it.chicken_fried": "🥓",
  "it.fries_fried": "🍟",
  "it.baked_bun": "🥖",
  "it.sandwich_base": "🧺",
  "it.crispy_base": "🫕",
  "p.grilled_sandwich": "🥪",
  "p.crispy_sandwich": "🌯",
  "p.fries_box": "🥡",
  "p.combo_box": "🍱",

  // medium
  "it.bun_raw": "🥯",
  "it.skin_raw": "🫓",
  "it.sauce_raw": "🫙",
  "it.drink_raw": "🧃",
  "it.chicken_marinated": "🥣",
  "it.chicken_breaded": "🍞",
  "it.patty_fried": "🍖",
  "it.bun_hot": "🥐",
  "it.skin_hot": "🫔",
  "it.sauce_cup": "🥄",
  "it.drink_cup": "🥤",
  "it.burger_base": "🍔",
  "it.wrap_base": "🧇",
  "p.burger_classic": "🍔",
  "p.burger_double": "🍔",
  "p.burger_trio": "🍔",
  "p.wrap_classic": "🌯",
  "p.wrap_double": "🌯",
  "p.fries": "🍟",
  "p.meal_burger": "🍱",
  "p.meal_wrap": "🍱",
};

// 🧺 is real art for an assembled sandwich base; the fallback has to look
// like "no art found" instead, so a mapping gap is visible.
export const itemEmoji = (id: string): string => ITEM_EMOJI[id] ?? "❓";


/**
 * The one-character tag that makes a line readable.
 *
 * Emoji alone cannot carry a kitchen: three burgers, two wraps and two meals
 * all want 🍔/🌯/🍱, so `o1 = 🥪1 🍱1 🥪1` says nothing. Every badge below is
 * unique across both scenarios, so the (emoji, badge) pair always identifies
 * the item — tickets, pantry chips and the missing-items toast all render it.
 */
const ITEM_BADGE: Readonly<Record<string, string>> = {
  raw_chicken: "生",
  raw_cola: "糖",
  fries: "薯条",
  patty: "鸡饼",
  burger: "汉堡",
  cola: "饮",

  // easy
  "it.chicken_raw": "生",
  "it.dough_raw": "面",
  "it.fry_raw": "冷",
  "it.chicken_grilled": "烤排",
  "it.chicken_fried": "炸排",
  "it.fries_fried": "炸薯",
  "it.baked_bun": "面包",
  "it.sandwich_base": "三胚",
  "it.crispy_base": "脆胚",
  "p.grilled_sandwich": "烤",
  "p.crispy_sandwich": "炸",
  "p.fries_box": "薯",
  "p.combo_box": "套餐",

  // medium
  "it.bun_raw": "生胚",
  "it.skin_raw": "生皮",
  "it.sauce_raw": "酱缸",
  "it.drink_raw": "糖缸",
  "it.chicken_marinated": "腌鸡",
  "it.chicken_breaded": "裹粉",
  "it.patty_fried": "炸饼",
  "it.bun_hot": "烤胚",
  "it.skin_hot": "热皮",
  "it.sauce_cup": "酱杯",
  "it.drink_cup": "饮杯",
  "it.burger_base": "汉胚",
  "it.wrap_base": "卷胚",
  "p.burger_classic": "汉",
  "p.burger_double": "汉双",
  "p.burger_trio": "汉三",
  "p.wrap_classic": "卷",
  "p.wrap_double": "卷双",
  "p.fries": "薯条",
  "p.meal_burger": "汉餐",
  "p.meal_wrap": "卷餐",
};

export const itemBadge = (id: string): string => ITEM_BADGE[id] ?? itemLabel(id).slice(0, 1);

/** Exposed for the uniqueness test; the UI goes through the helpers above. */
export const ITEM_BADGE_IDS: Readonly<Record<string, string>> = ITEM_BADGE;


/** Faces for the order rail. Index is a hash of the order id, so a ticket
 *  always keeps the same customer between renders. */
const CUSTOMERS = ["😀", "🧑‍🦱", "👩", "🧓", "🧒", "🥸", "👨‍🍳", "👩‍🦰"] as const;

function hashOf(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export const customerEmoji = (seed: string): string =>
  CUSTOMERS[hashOf(seed) % CUSTOMERS.length] ?? "😀";

/** Hand-pinned tilt in degrees, stable per order id. */
export function ticketTilt(seed: string): number {
  return (hashOf(seed) % 5) - 2;
}

export const COIN = "🪙";
export const BELL = "🔔";
export const CLOCK = "🕑";
