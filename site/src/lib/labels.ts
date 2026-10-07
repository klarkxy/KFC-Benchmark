/**
 * The replay format carries ids only — no PublicConfig — so the UI keeps a
 * small display dictionary for the demo scenario and falls back to raw ids.
 * Practice scenarios (scenarios/<tier>/kitchen.json) use their own id space;
 * both are listed here, unknown ids always degrade to the raw id.
 */
const STATION_LABELS: Readonly<Record<string, string>> = {
  prep_a: "备料 A",
  prep_b: "备料 B",
  fry_1: "炸锅 1",
  fry_2: "炸锅 2",
  assemble_1: "组装 1",
  assemble_2: "组装 2",

  "st.grill": "烤炉",
  "st.fryer": "炸锅",
  "st.oven": "烤箱",
  "st.counter": "组装台",
  "st.packager": "打包台",
  "st.marinator": "腌料机",
  "st.breader": "裹粉机",
  "st.fryer_a": "炸锅 A",
  "st.fryer_b": "炸锅 B",
  "st.heater_a": "加热台 A",
  "st.heater_b": "加热台 B",
  "st.assembler": "组装台",
  "st.dispenser": "出餐台",
};

const ITEM_LABELS: Readonly<Record<string, string>> = {
  raw_chicken: "生鸡排",
  raw_cola: "可乐原浆",
  fries: "薯条",
  patty: "烤鸡排",
  burger: "汉堡",
  cola: "可乐",

  "it.chicken_raw": "生鸡胸",
  "it.chicken_grilled": "烤鸡排",
  "it.chicken_fried": "炸鸡排",
  "it.chicken_marinated": "腌鸡排",
  "it.chicken_breaded": "裹粉鸡排",
  "it.patty_fried": "炸鸡饼",
  "it.dough_raw": "面团",
  "it.baked_bun": "烤面包胚",
  "it.bun_raw": "生面包胚",
  "it.bun_hot": "烤面包胚",
  "it.skin_raw": "卷饼皮",
  "it.skin_hot": "加热卷饼皮",
  "it.fry_raw": "冷冻薯条",
  "it.fries_fried": "炸薯条",
  "it.sauce_raw": "酱料",
  "it.sauce_cup": "分装酱料",
  "it.drink_raw": "饮料糖浆",
  "it.drink_cup": "倒好的饮料",
  "it.sandwich_base": "三明治胚",
  "it.crispy_base": "脆鸡胚",
  "it.burger_base": "汉堡胚",
  "it.wrap_base": "卷饼胚",
  "p.grilled_sandwich": "烤鸡三明治",
  "p.crispy_sandwich": "炸鸡三明治",
  "p.fries_box": "薯条盒",
  "p.combo_box": "三明治套餐",
  "p.burger_classic": "经典汉堡",
  "p.burger_double": "双层汉堡",
  "p.burger_trio": "三层汉堡",
  "p.wrap_classic": "经典卷饼",
  "p.wrap_double": "双层卷饼",
  "p.fries": "薯条",
  "p.meal_burger": "汉堡套餐",
  "p.meal_wrap": "卷饼套餐",
};

const RECIPE_LABELS: Readonly<Record<string, string>> = {
  r_fry: "炸薯条",
  r_patty: "烤鸡排",
  r_burger: "组装汉堡",
  r_cola: "倒可乐",

  "r.grill_chicken": "烤鸡排",
  "r.fry_chicken": "炸鸡排",
  "r.fry_fries": "炸薯条",
  "r.bake_bun": "烤面包胚",
  "r.assemble_grilled": "组装三明治胚",
  "r.assemble_crispy": "组装脆鸡胚",
  "r.pack_grilled_sandwich": "打包烤鸡三明治",
  "r.pack_crispy_sandwich": "打包炸鸡三明治",
  "r.pack_fries_box": "打包薯条盒",
  "r.pack_combo_box": "打包三明治套餐",
  "r.marinate": "腌鸡排",
  "r.bread": "裹粉鸡排",
  "r.fry_patty": "炸鸡饼",
  "r.heat_bun": "烤面包胚",
  "r.heat_skin": "加热卷饼皮",
  "r.portion_sauce": "分装酱料",
  "r.pour_drink": "倒饮料",
  "r.build_burger": "组装汉堡胚",
  "r.build_wrap": "组装卷饼胚",
  "r.pack_burger_classic": "打包经典汉堡",
  "r.pack_burger_double": "打包双层汉堡",
  "r.pack_burger_trio": "打包三层汉堡",
  "r.pack_wrap_classic": "打包经典卷饼",
  "r.pack_wrap_double": "打包双层卷饼",
  "r.pack_fries": "打包薯条",
  "r.pack_meal_burger": "打包汉堡套餐",
  "r.pack_meal_wrap": "打包卷饼套餐",
};

function label(map: Readonly<Record<string, string>>, id: string): string {
  return map[id] ?? id;
}

export const stationLabel = (id: string): string => label(STATION_LABELS, id);
export const itemLabel = (id: string): string => label(ITEM_LABELS, id);
export const recipeLabel = (id: string): string => label(RECIPE_LABELS, id);

export const DIFFICULTY_LABELS: Readonly<Record<string, string>> = {
  easy: "简单",
  medium: "中等",
  complex: "复杂",
};

export const STATUS_LABELS: Readonly<Record<string, string>> = {
  completed: "完成",
  candidate_failed: "候选失败",
  infra_failed: "基础设施失败",
  canceled: "已取消",
  disqualified: "已取消资格",
};
