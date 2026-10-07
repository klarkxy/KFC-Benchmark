import { formatMinor, formatSimMs } from "../lib/format";
import { itemLabel, recipeLabel, stationLabel } from "../lib/labels";
import type { ReplayEvent } from "./reducer";

/** One-line Chinese summary of an event, for the replay log panel. */
export function describeEvent(event: ReplayEvent): string {
  switch (event.type) {
    case "clock_advanced":
      return `时钟 ${formatSimMs(event.payload.from_ms)} → ${formatSimMs(event.payload.to_ms)}`;

    case "order_arrived": {
      const order = event.payload.order;
      const items = order.items.map((item) => `${itemLabel(item.item_id)}×${item.quantity}`).join(" ");
      return `订单 ${order.id} 到达（${items}，${formatMinor(order.value_minor)}）`;
    }

    case "task_started": {
      const task = event.payload.task;
      return `${stationLabel(task.station_id)} 启动 ${task.id}（${recipeLabel(task.recipe_id)} ×${task.batches}）`;
    }

    case "task_completed": {
      const { task, lots } = event.payload;
      return `${task.id} 完成，产出 ${lots.length} 批（${formatSimMs(task.finish_at_ms)}）`;
    }

    case "order_delivered": {
      const payload = event.payload;
      const lots = new Set(payload.consumed.map((entry) => entry.lot_id));
      return `交付 ${payload.order_id}（${payload.delivery_id}，消耗 ${lots.size} 个 lot，营收 ${formatMinor(payload.revenue_minor)}）`;
    }

    case "action_rejected":
      return `动作被拒绝：${event.payload.result.code}`;

    case "wake_updated":
      return `更新唤醒时间 → ${event.payload.result.pending_wake_at_ms ?? "null"}`;

    case "wake_fired":
      return `唤醒触发 @ ${formatSimMs(event.payload.at_ms)}`;

    case "run_finished":
      return `运行结束：${event.payload.status}，得分 ${formatMinor(event.payload.score_minor)}`;

    default:
      return "未知事件";
  }
}
