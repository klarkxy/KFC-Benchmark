import { formatMinor, formatSimMs } from "../lib/format";
import { itemLabel, recipeLabel, stationLabel } from "../lib/labels";
import { inventoryOf, taskProgress, type ReplayState } from "./reducer";

/**
 * Schematic kitchen view. Canvas is logical-pixel based: the caller sets up
 * the DPR transform, this only draws boxes, bars and text.
 */
const COLORS = {
  canvas: "#0b0f14",
  panel: "#131a22",
  panelBorder: "#243040",
  text: "#e6edf3",
  muted: "#8b98a9",
  accent: "#58a6ff",
  good: "#3fb950",
  progressTrack: "#1d2733",
};

const FONT = '12px "JetBrains Mono", "SFMono-Regular", Consolas, monospace';
const FONT_SMALL = '10px "JetBrains Mono", "SFMono-Regular", Consolas, monospace';
const FONT_TITLE = '13px "JetBrains Mono", "SFMono-Regular", Consolas, monospace';

const PADDING = 12;
const HEADER_HEIGHT = 46;
const STATION_BOX = { width: 208, height: 74, gapX: 12, gapY: 10 };

function panel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  title: string,
): void {
  ctx.fillStyle = COLORS.panel;
  ctx.strokeStyle = COLORS.panelBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = COLORS.muted;
  ctx.font = FONT_SMALL;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(title, x + 10, y + 8);
}

function clipText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

function drawHeader(
  ctx: CanvasRenderingContext2D,
  state: ReplayState,
  width: number,
): void {
  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(0, 0, width, HEADER_HEIGHT);
  ctx.strokeStyle = COLORS.panelBorder;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_HEIGHT - 0.5);
  ctx.lineTo(width, HEADER_HEIGHT - 0.5);
  ctx.stroke();

  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = COLORS.accent;
  ctx.font = FONT_TITLE;
  ctx.fillText(`t = ${formatSimMs(state.nowMs)}`, PADDING, HEADER_HEIGHT / 2);

  ctx.fillStyle = COLORS.text;
  ctx.font = FONT;
  const stats: Array<[string, string]> = [
    ["营收", formatMinor(state.revenueMinor)],
    ["已交付", String(state.deliveredOrders)],
    ["队列", String(state.queue.length)],
    ["进行中", String(state.activeTasks.length)],
  ];
  let x = PADDING + 112;
  for (const [label, value] of stats) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = FONT_SMALL;
    ctx.fillText(label, x, HEADER_HEIGHT / 2);
    ctx.fillStyle = COLORS.text;
    ctx.font = FONT;
    ctx.fillText(value, x + 42, HEADER_HEIGHT / 2);
    x += 108;
  }
  if (state.finished) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = FONT_SMALL;
    ctx.textAlign = "right";
    ctx.fillText(
      `run_finished · ${state.finished.status}`,
      width - PADDING,
      HEADER_HEIGHT / 2,
    );
  }
}

function drawStations(
  ctx: CanvasRenderingContext2D,
  state: ReplayState,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  panel(ctx, x, y, width, height, "工位 stations");
  if (state.stations.length === 0) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = FONT_SMALL;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("尚无工位活动", x + 10, y + 30);
    return;
  }

  const columns = Math.max(1, Math.floor((width - 20 + STATION_BOX.gapX) / (STATION_BOX.width + STATION_BOX.gapX)));
  const innerTop = y + 26;
  state.stations.slice(0, Math.floor((height - 36) / (STATION_BOX.height + STATION_BOX.gapY)) * columns)
    .forEach((station, index) => {
      const boxX = x + 10 + (index % columns) * (STATION_BOX.width + STATION_BOX.gapX);
      const boxY = innerTop + Math.floor(index / columns) * (STATION_BOX.height + STATION_BOX.gapY);
      const busy = station.task !== null;
      ctx.fillStyle = busy ? "#182433" : COLORS.canvas;
      ctx.strokeStyle = busy ? COLORS.accent : COLORS.panelBorder;
      ctx.lineWidth = busy ? 1.5 : 1;
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, STATION_BOX.width, STATION_BOX.height, 4);
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.font = FONT;
      ctx.fillStyle = COLORS.text;
      ctx.fillText(
        clipText(ctx, `${station.id} · ${stationLabel(station.id)}`, STATION_BOX.width - 16),
        boxX + 8,
        boxY + 7,
      );

      if (!station.task) {
        ctx.font = FONT_SMALL;
        ctx.fillStyle = COLORS.muted;
        ctx.fillText("空闲", boxX + 8, boxY + 28);
        return;
      }

      const task = station.task;
      const progress = taskProgress(task, state.nowMs);
      ctx.font = FONT_SMALL;
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(
        clipText(ctx, `${task.id} · ${recipeLabel(task.recipe_id)} ×${task.batches}`, STATION_BOX.width - 56),
        boxX + 8,
        boxY + 28,
      );
      ctx.textAlign = "right";
      ctx.fillText(`${Math.round(progress * 100)}%`, boxX + STATION_BOX.width - 8, boxY + 28);
      ctx.textAlign = "left";

      const barX = boxX + 8;
      const barY = boxY + 46;
      const barWidth = STATION_BOX.width - 16;
      ctx.fillStyle = COLORS.progressTrack;
      ctx.beginPath();
      ctx.roundRect(barX, barY, barWidth, 6, 3);
      ctx.fill();
      ctx.fillStyle = COLORS.accent;
      ctx.beginPath();
      ctx.roundRect(barX, barY, Math.max(2, barWidth * progress), 6, 3);
      ctx.fill();
    });
}

function drawQueue(
  ctx: CanvasRenderingContext2D,
  state: ReplayState,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  panel(ctx, x, y, width, height, `待处理订单 queue (${state.queue.length})`);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const rows = Math.floor((height - 40) / 18);
  const visible = state.queue.slice(0, Math.max(0, rows));
  if (visible.length === 0) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = FONT_SMALL;
    ctx.fillText("队列为空", x + 10, y + 30);
  }
  visible.forEach((order, index) => {
    const rowY = y + 28 + index * 18;
    ctx.font = FONT_SMALL;
    ctx.fillStyle = COLORS.text;
    ctx.fillText(order.id, x + 10, rowY);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(
      clipText(
        ctx,
        order.items.map((item) => `${itemLabel(item.item_id)}×${item.quantity}`).join(" "),
        width - 118,
      ),
      x + 62,
      rowY,
    );
    ctx.textAlign = "right";
    ctx.fillStyle = COLORS.good;
    ctx.fillText(formatMinor(order.value_minor), x + width - 10, rowY);
    ctx.textAlign = "left";
  });
}

function drawInventory(
  ctx: CanvasRenderingContext2D,
  state: ReplayState,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const entries = inventoryOf(state);
  panel(ctx, x, y, width, height, `库存 inventory (${entries.length})`);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = FONT_SMALL;
  if (entries.length === 0) {
    ctx.fillStyle = COLORS.muted;
    ctx.fillText("无在库成品", x + 10, y + 30);
    return;
  }
  const perColumn = Math.max(1, Math.floor((height - 36) / 18));
  entries.forEach((entry, index) => {
    const column = Math.floor(index / perColumn);
    const row = index % perColumn;
    const cellX = x + 10 + column * 150;
    const cellY = y + 28 + row * 18;
    if (cellX + 140 > x + width) return;
    ctx.fillStyle = COLORS.text;
    ctx.fillText(clipText(ctx, itemLabel(entry.item_id), 92), cellX, cellY);
    ctx.textAlign = "right";
    ctx.fillStyle = COLORS.accent;
    ctx.fillText(String(entry.quantity), cellX + 130, cellY);
    ctx.textAlign = "left";
  });
}

export function drawReplay(
  ctx: CanvasRenderingContext2D,
  state: ReplayState,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = COLORS.canvas;
  ctx.fillRect(0, 0, width, height);
  drawHeader(ctx, state, width);

  const bodyTop = HEADER_HEIGHT + PADDING;
  const bodyHeight = height - bodyTop - PADDING;
  const leftWidth = Math.max(STATION_BOX.width * 2 + STATION_BOX.gapX + 20, Math.round(width * 0.52));
  const inventoryHeight = 96;
  const rightX = leftWidth + PADDING;
  const rightWidth = Math.max(180, width - rightX - PADDING);

  drawStations(ctx, state, PADDING, bodyTop, leftWidth, bodyHeight - inventoryHeight - PADDING);
  drawInventory(
    ctx,
    state,
    PADDING,
    bodyTop + bodyHeight - inventoryHeight,
    leftWidth,
    inventoryHeight,
  );
  drawQueue(ctx, state, rightX, bodyTop, rightWidth, bodyHeight);
}
