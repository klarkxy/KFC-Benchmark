/**
 * The replay format carries ids only — no PublicConfig — so the UI keeps a
 * small display dictionary for the demo scenario and falls back to raw ids.
 */
const STATION_LABELS: Readonly<Record<string, string>> = {
  prep_a: "备料 A",
  prep_b: "备料 B",
  fry_1: "炸锅 1",
  fry_2: "炸锅 2",
  assemble_1: "组装 1",
  assemble_2: "组装 2",
};

const ITEM_LABELS: Readonly<Record<string, string>> = {
  raw_chicken: "生鸡排",
  raw_cola: "可乐原浆",
  fries: "薯条",
  patty: "烤鸡排",
  burger: "汉堡",
  cola: "可乐",
};

const RECIPE_LABELS: Readonly<Record<string, string>> = {
  r_fry: "炸薯条",
  r_patty: "烤鸡排",
  r_burger: "组装汉堡",
  r_cola: "倒可乐",
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
