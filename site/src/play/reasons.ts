import type { ActionCode, WakeCode } from "@kitchensched/contracts";

/**
 * Kernel feedback in Chinese. An `ActionResult.code` is the player's only
 * answer to "why did that not happen", so the code alone is never shown
 * without a sentence saying what to do about it.
 */
const ACTION_REASONS: Readonly<Record<ActionCode, string>> = {
  OK: "成功",
  UNKNOWN_RECIPE: "配方不存在。",
  UNKNOWN_STATION: "工位不存在。",
  INCOMPATIBLE_STATION: "该工位做不了这道配方，请换一个配方支持的工位。",
  STATION_BUSY: "工位正忙，上一个任务还没做完。",
  INVALID_BATCH: "批次数超出该工位的产能上限（或不是正整数）。",
  UNKNOWN_LOT: "引用的原料批次不存在。",
  DUPLICATE_LOT: "同一个批次被两个动作重复占用。",
  INVALID_INPUT: "投入的原料与配方不符。",
  INSUFFICIENT_INPUT: "在库原料不足。",
  UNKNOWN_ORDER: "订单不存在。",
  INCOMPLETE_ORDER: "库存凑不齐整单，本场景不支持部分交付。",
  ALREADY_DELIVERED: "这单已经交付过了。",
  ACTION_ID_CONFLICT: "动作 id 重复（同一 id 不能用于两个动作）。",
  DEADLINE_REACHED: "已到打烊时间，只能收尾。",
};

export function actionCodeReason(code: ActionCode): string {
  return ACTION_REASONS[code];
}

const WAKE_REASONS: Readonly<Record<WakeCode, string>> = {
  SCHEDULED: "已注册定时唤醒。",
  CANCELED: "未设置唤醒：时间会直接跳到下一个事件（新订单到达或任务完成）。",
  INVALID_WAKE_TIME: "唤醒时间非法，已忽略。",
};

export function wakeCodeReason(code: WakeCode): string {
  return WAKE_REASONS[code];
}
