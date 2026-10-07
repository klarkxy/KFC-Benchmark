import { useEffect, useMemo, useState } from "react";
import {
  planDeliverOutputs,
  planStartInputs,
  producedItemIds,
  type Action,
  type LotQty,
  type Observation,
  type PublicConfig,
  type Recipe,
} from "@kitchensched/game";
import { formatMinor, formatSimMs } from "../lib/format";
import { itemLabel, recipeLabel, stationLabel } from "../lib/labels";

/**
 * Action composer: builds legal `Action`s for the decision the player owes
 * next, one staged action at a time.
 *
 * Every staged action carries the `LotQty[]` it drew on. The reservation
 * accumulator is re-derived from all staged entries on every render, so two
 * actions can never claim the same lot and deleting one immediately frees its
 * lots again.
 */
export interface StagedAction {
  action: Action;
  /** Lots this action promised; the accumulator is their sum over `staged`. */
  lots: readonly LotQty[];
  label: string;
}

export function accumulateReservations(staged: readonly StagedAction[]): Map<string, number> {
  const reserved = new Map<string, number>();
  for (const entry of staged) {
    for (const lot of entry.lots) {
      reserved.set(lot.lot_id, (reserved.get(lot.lot_id) ?? 0) + lot.quantity);
    }
  }
  return reserved;
}

/**
 * Batches are a positive integer in the contract: the kernel answers a
 * fractional one with INVALID_BATCH and the decision is spent. Flooring here
 * means 2.7 can never reach a staged action.
 */
const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(Math.floor(value), max));

function itemLine(lines: readonly { item_id: string; quantity: number }[]): string {
  if (lines.length === 0) return "—";
  return lines.map((line) => `${itemLabel(line.item_id)}×${line.quantity}`).join(" + ");
}

function planLines(lots: readonly LotQty[]): string {
  if (lots.length === 0) return "—";
  return lots.map((lot) => `${lot.lot_id}×${lot.quantity}`).join(" + ");
}

interface ComposerProps {
  config: PublicConfig;
  observation: Observation;
  staged: readonly StagedAction[];
  /** Bumped by the parent after a decision is submitted, to reset the draft. */
  resetKey: number;
  /** Issues the id for a newly staged action; never reuse one. */
  makeActionId: () => string;
  onStage: (entry: StagedAction) => void;
}

type Mode = "start" | "deliver";

export function Composer({
  config,
  observation,
  staged,
  resetKey,
  makeActionId,
  onStage,
}: ComposerProps): JSX.Element {
  const firstRecipe = config.recipes[0];
  const firstOrder = observation.orders[0];
  const [mode, setMode] = useState<Mode>("start");
  const [recipeId, setRecipeId] = useState<string>(firstRecipe?.id ?? "");
  const [stationId, setStationId] = useState<string>(
    firstRecipe?.station_options[0]?.station_id ?? "",
  );
  const [batches, setBatches] = useState(1);
  const [orderId, setOrderId] = useState<string>(firstOrder?.id ?? "");

  // A new decision point invalidates the draft: the world moved on.
  // The endgame is deliver-only, so land on the deliver tab there — the
  // disabled 开工 tab alone does not keep the start form off screen.
  useEffect(() => {
    const recipe = config.recipes[0];
    setMode(observation.final ? "deliver" : "start");
    setRecipeId(recipe?.id ?? "");
    setStationId(recipe?.station_options[0]?.station_id ?? "");
    setBatches(1);
    setOrderId(observation.orders[0]?.id ?? "");
  }, [resetKey, config, observation]);

  const produced = useMemo(() => producedItemIds(config), [config]);
  const reserved = useMemo(() => accumulateReservations(staged), [staged]);
  const busyStationIds = useMemo(() => {
    const busy = new Set<string>();
    for (const station of observation.stations) {
      if (station.task_id !== null) busy.add(station.id);
    }
    return busy;
  }, [observation]);
  const stagedStations = useMemo(
    () =>
      new Set(
        staged
          .map((entry) => (entry.action.type === "start" ? entry.action.station_id : null))
          .filter((id): id is string => id !== null),
      ),
    [staged],
  );
  const stagedOrders = useMemo(
    () =>
      new Set(
        staged
          .map((entry) => (entry.action.type === "deliver" ? entry.action.order_id : null))
          .filter((id): id is string => id !== null),
      ),
    [staged],
  );

  const recipe: Recipe | undefined = config.recipes.find((entry) => entry.id === recipeId);
  const option = recipe?.station_options.find((entry) => entry.station_id === stationId);
  const maxBatches = option?.max_batches ?? 1;
  const effectiveBatches = clamp(batches, 1, maxBatches);
  const startPlan = recipe && option
    ? planStartInputs(observation.inventory, recipe, effectiveBatches, produced, reserved)
    : null;
  const order = observation.orders.find((entry) => entry.id === orderId);
  const deliverPlan = order
    ? planDeliverOutputs(observation.inventory, order, reserved)
    : null;

  const stationBlocked = (id: string): string | null => {
    if (busyStationIds.has(id)) return "执行中";
    if (stagedStations.has(id)) return "本决策已占用";
    return null;
  };
  const selectedBlocked = stationId === "" ? null : stationBlocked(stationId);

  const stageStart = (): void => {
    // Doc 02 §8: the final observation is deliver-only; the kernel would
    // reject a start, so never stage one in the endgame.
    if (observation.final) return;
    if (!recipe || !option || !startPlan || !startPlan.complete) return;
    onStage({
      action: {
        type: "start",
        action_id: makeActionId(),
        recipe_id: recipe.id,
        station_id: option.station_id,
        batches: effectiveBatches,
        input_lots: [...startPlan.lots],
      },
      lots: startPlan.lots,
      label: `开工 ${recipeLabel(recipe.id)} ×${effectiveBatches} @ ${stationLabel(option.station_id)}`,
    });
  };

  const stageDeliver = (): void => {
    if (!order || !deliverPlan || !deliverPlan.complete) return;
    onStage({
      action: { type: "deliver", action_id: makeActionId(), order_id: order.id, output_lots: [...deliverPlan.lots] },
      lots: deliverPlan.lots,
      label: `交付 ${order.id}（${itemLine(order.items)}）`,
    });
  };

  return (
    <div className="panel">
      <h3>下达动作</h3>

      <div className="tabs compact" role="tablist" aria-label="动作类型">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "start"}
          className={mode === "start" ? "tab active" : "tab"}
          disabled={observation.final}
          onClick={() => setMode("start")}
        >
          开工
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "deliver"}
          className={mode === "deliver" ? "tab active" : "tab"}
          onClick={() => setMode("deliver")}
        >
          交付
        </button>
        {observation.final ? (
          <span className="muted small endgame-hint">收尾阶段：只能交付</span>
        ) : null}
      </div>

      {mode === "start" ? (
        <div className="form-grid">
          <label className="field">
            <span>配方</span>
            <select
              value={recipeId}
              onChange={(event) => {
                const next = config.recipes.find((entry) => entry.id === event.target.value);
                setRecipeId(event.target.value);
                setStationId(next?.station_options[0]?.station_id ?? "");
                setBatches(1);
              }}
            >
              {config.recipes.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {recipeLabel(entry.id)}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>工位</span>
            <select value={stationId} onChange={(event) => setStationId(event.target.value)}>
              {(recipe?.station_options ?? []).map((entry) => {
                const blocked = stationBlocked(entry.station_id);
                return (
                  <option key={entry.station_id} value={entry.station_id} disabled={blocked !== null}>
                    {stationLabel(entry.station_id)}
                    {blocked ? `（${blocked}）` : ` · ${formatSimMs(entry.duration_ms)}`}
                  </option>
                );
              })}
            </select>
          </label>

          <label className="field">
            <span>批次（上限 {maxBatches}）</span>
            <input
              type="number"
              min={1}
              max={maxBatches}
              step={1}
              value={effectiveBatches}
              onChange={(event) => setBatches(clamp(Number(event.target.value) || 1, 1, maxBatches))}
            />
          </label>

          <dl className="kv recipe-info">
            <dt>原料</dt>
            <dd>{recipe ? itemLine(recipe.inputs) : "—"}</dd>
            <dt>产出</dt>
            <dd>{recipe ? itemLine(recipe.outputs) : "—"}</dd>
            <dt>耗时</dt>
            <dd>
              {option
                ? `${formatSimMs(option.duration_ms)}（固定耗时，批次只放大投料与产出）`
                : "—"}
            </dd>
            <dt>产能</dt>
            <dd>{option ? `单次最多 ${option.max_batches} 批` : "—"}</dd>
            <dt>投入批次</dt>
            <dd className="mono small wrap">{startPlan ? planLines(startPlan.lots) : "—"}</dd>
          </dl>

          {startPlan && !startPlan.complete ? (
            <p className="feedback bad">
              原料不足：{startPlan.missing.map((line) => `${itemLabel(line.item_id)}×${line.quantity}`).join("、")}
            </p>
          ) : null}
          {selectedBlocked ? <p className="feedback bad">工位不可用：{selectedBlocked}</p> : null}

          <button
            type="button"
            className="button"
            disabled={
              observation.final ||
              !recipe ||
              !option ||
              !startPlan?.complete ||
              stationBlocked(option?.station_id ?? "") !== null
            }
            onClick={stageStart}
          >
            加入本决策
          </button>
        </div>
      ) : (
        <div className="form-grid">
          <label className="field">
            <span>待交付订单</span>
            <select value={orderId} onChange={(event) => setOrderId(event.target.value)}>
              {observation.orders.length === 0 ? <option value="">（无待处理订单）</option> : null}
              {observation.orders.map((entry) => (
                <option
                  key={entry.id}
                  value={entry.id}
                  disabled={stagedOrders.has(entry.id)}
                >
                  {entry.id} · {itemLine(entry.items)}
                  {stagedOrders.has(entry.id) ? "（已加入本决策）" : ""}
                </option>
              ))}
            </select>
          </label>

          <dl className="kv recipe-info">
            <dt>订单内容</dt>
            <dd>{order ? itemLine(order.items) : "—"}</dd>
            <dt>售价</dt>
            <dd className="money">{order ? formatMinor(order.value_minor) : "—"}</dd>
            <dt>交付批次</dt>
            <dd className="mono small wrap">{deliverPlan ? planLines(deliverPlan.lots) : "—"}</dd>
          </dl>

          {deliverPlan && !deliverPlan.complete ? (
            <p className="feedback bad">
              库存不足：{deliverPlan.missing.map((line) => `${itemLabel(line.item_id)}×${line.quantity}`).join("、")}
            </p>
          ) : null}

          <button
            type="button"
            className="button"
            disabled={!order || !deliverPlan?.complete}
            onClick={stageDeliver}
          >
            加入本决策
          </button>
        </div>
      )}
    </div>
  );
}
