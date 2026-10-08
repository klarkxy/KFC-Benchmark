import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  planDeliverOutputs,
  planStartInputs,
  producedItemIds,
  type Lot,
  type Order,
  type PublicConfig,
  type Recipe,
} from "@kitchensched/game";

import { formatMinor, formatSimMs } from "../lib/format";
import { itemLabel, recipeLabel, stationLabel } from "../lib/labels";
import { SPEEDS, queuedOrderIds, queuedStationIds, type Speed, type Toast } from "./engine";
import {
  COIN,
  customerEmoji,
  itemBadge,
  itemEmoji,
  recipeEmoji,
  stationEmoji,
  ticketTilt,
} from "./icons";
import { releaseFocus } from "./interaction";
import type { CoinBurst, GameFlow } from "./useGameFlow";


/**
 * The kitchen itself: a day clock, a rail of pinned order tickets, the station
 * floor and the pantry. Every tap queues an action for the next decision
 * point — nothing here talks to the kernel directly.
 */

type Vars = React.CSSProperties & Record<`--${string}`, string | number>;

/** `station_options[number]` — the contracts package does not re-export it. */
type StationOption = Recipe["station_options"][number];


interface GameScreenProps {
  config: PublicConfig;
  flow: GameFlow;
  onExit: () => void;
}

export function GameScreen({ config, flow, onExit }: GameScreenProps): JSX.Element {
  const { folded, phase } = flow;
  const [openStation, setOpenStation] = useState<string | null>(null);
  const [shakeId, setShakeId] = useState<string | null>(null);
  const [hoverOrder, setHoverOrder] = useState<string | null>(null);

  // What the player may act on: the kernel's parked observation, not the
  // animation. The rail still reads the fold, so tickets land on cue.
  const lots = flow.stock;
  const produced = useMemo(() => producedItemIds(config), [config]);
  const queuedStations = useMemo(() => queuedStationIds(flow.queue), [flow.queue]);
  const queuedOrders = useMemo(() => queuedOrderIds(flow.queue), [flow.queue]);

  const closePopover = useCallback(() => {
    setOpenStation(null);
    flow.setInteracting(false);
  }, [flow]);

  const openRecipePopover = (stationId: string): void => {
    const snapshot = folded.stations.find((entry) => entry.id === stationId);
    if (!snapshot || snapshot.task !== null || queuedStations.has(stationId)) return;
    setOpenStation(stationId);
    flow.setInteracting(true);
  };

  const shake = (id: string): void => {
    setShakeId(id);
    window.setTimeout(() => setShakeId((current) => (current === id ? null : current)), 480);
  };

  const tickets = useMemo(
    () => [
      ...folded.queue.map((order) => ({ order, done: false })),
      ...flow.delivered.map((entry) => ({ order: entry.order, done: true })),
    ],
    [folded.queue, flow.delivered],
  );

  const pantry = useMemo(() => {
    const totals = new Map<string, number>();
    for (const lot of lots) {
      totals.set(lot.item_id, (totals.get(lot.item_id) ?? 0) + lot.quantity);
    }
    return [...totals.entries()]
      .map(([item_id, quantity]) => ({ item_id, quantity }))
      .sort((a, b) => a.item_id.localeCompare(b.item_id));
  }, [lots]);

  // Hovering a ticket highlights exactly the shelf chips it needs.
  const hoveredOrder = hoverOrder ? folded.queue.find((order) => order.id === hoverOrder) : undefined;
  const needed = useMemo(() => {
    const ids = new Set<string>();
    for (const line of hoveredOrder?.items ?? []) ids.add(line.item_id);
    return ids;
  }, [hoveredOrder]);

  const rootVars: Vars = { "--day-end": config.end_at_ms };

  return (
    <div
      ref={flow.rootRef}
      className="play-root k-game"
      data-phase={phase}
      data-hover-order={hoverOrder ?? undefined}
      style={rootVars}
    >
      <Hud config={config} flow={flow} onExit={onExit} />

      <section className="k-rail-wrap" aria-label="订单栏">
        <h2 className="k-rail-title">
          <span>订单栏</span>
          <span className="k-muted">{tickets.length} 张小票</span>
        </h2>
        <div className="k-rail">
          {tickets.length === 0 ? (
            <p className="k-rail-empty">还没有客人来 —— 先把生产线开起来，订单会自己飞进来。</p>
          ) : (
            tickets.map(({ order, done }) => {
              const plan = planDeliverOutputs(lots, order, flow.reservations);
              const queued = queuedOrders.has(order.id);
              const ready = plan.complete && !queued;
              return (
                <button
                  key={order.id}
                  type="button"
                  data-order-id={order.id}
                  aria-label={`订单 ${order.id}，${order.items
                    .map((line) => `${itemLabel(line.item_id)}×${line.quantity}`)
                    .join("、")}，售价 ${formatMinor(order.value_minor)}`}
                  className={classList(
                    "k-ticket",
                    done && "is-delivered",
                    queued && "is-queued",
                    !done && ready && "is-ready",
                    shakeId === order.id && "is-shake",
                  )}
                  style={{ "--tilt": `${ticketTilt(order.id)}deg` } as Vars}
                  disabled={done}
                  onMouseEnter={() => setHoverOrder(order.id)}
                  onMouseLeave={() => setHoverOrder(null)}
                  onFocus={() => setHoverOrder(order.id)}
                  onBlur={() => setHoverOrder(null)}
                  onClick={(event) => {
                    releaseFocus(event);
                    if (done || queued) return;
                    if (ready) {
                      flow.queueDeliver(order);
                      return;
                    }
                    shake(order.id);
                    flow.notifyMissing(
                      plan.missing
                        .map(
                          (line) =>
                            `${itemEmoji(line.item_id)} ${itemLabel(line.item_id)}×${line.quantity}`,
                        )
                        .join("、"),
                    );
                  }}
                >
                  <span className="k-pin" aria-hidden="true" />
                  <span className="k-customer" aria-hidden="true">
                    {customerEmoji(order.id)}
                  </span>
                  <span className="k-ticket-id">{order.id}</span>
                  <span className="k-ticket-items">
                    {order.items.map((line) => (
                      <span className="k-ticket-item" key={line.item_id}>
                        <span aria-hidden="true">{itemEmoji(line.item_id)}</span>
                        <i className="k-badge">{itemBadge(line.item_id)}</i>
                        {line.quantity}
                      </span>
                    ))}
                  </span>
                  <span className="k-ticket-foot">
                    <span className="k-money">
                      {COIN} {formatMinor(order.value_minor)}
                    </span>
                    <span className="k-muted">{formatSimMs(order.arrived_at_ms)}</span>
                  </span>
                  {done ? <span className="k-stamp done">✅ 已交付</span> : null}
                  {queued ? <span className="k-stamp queued">已排队</span> : null}
                </button>
              );
            })
          )}
        </div>
      </section>

      <div className="k-main">
        <section className="k-floor" aria-label="厨房工位">
          {folded.stations.map((station) => {
            const task = station.task;
            const queued = queuedStations.has(station.id);
            return (
              <button
                key={station.id}
                type="button"
                data-station-id={station.id}
                aria-label={`工位 ${stationLabel(station.id)}`}
                className={classList(
                  "k-station",
                  // Mutually exclusive: `is-idle` must mean "you can tap me
                  // right now", otherwise a station waiting on its queued
                  // action looks clickable and is not.
                  task ? "is-busy" : queued ? "is-queued" : "is-idle",
                )}
                style={
                  task
                    ? ({ "--t0": task.started_at_ms, "--t1": task.finish_at_ms } as Vars)
                    : undefined
                }
                disabled={task !== null || queued}
                onClick={(event) => { releaseFocus(event); openRecipePopover(station.id); }}
              >
                {task ? <span className="k-ring" aria-hidden="true" /> : null}
                <span className="k-station-emoji" aria-hidden="true">
                  {stationEmoji(station.id)}
                </span>
                <span className="k-station-name">{stationLabel(station.id)}</span>
                {task ? (
                  <>
                    <span className="k-task">
                      <span aria-hidden="true">{recipeEmoji(task.recipe_id)}</span>
                      {recipeLabel(task.recipe_id)} ×{task.batches}
                    </span>
                    <span className="k-finish">⏱ {formatSimMs(task.finish_at_ms)} 出锅</span>
                  </>
                ) : queued ? (
                  <span className="k-idle">已排队 · 下一拍开工</span>
                ) : (
                  <span className="k-idle">点我开工 👆</span>
                )}
              </button>
            );
          })}
        </section>

        <aside className="k-side">
          <section className="k-pantry" aria-label="库存货架">
            <h3 className="k-side-title">库存货架</h3>
            {pantry.length === 0 ? (
              <p className="k-muted">空架子 —— 开工产出后这里会堆起来。</p>
            ) : (
              <div className="k-chips">
                {pantry.map((entry) => (
                  <span
                    key={entry.item_id}
                    className={classList(
                      "k-chip",
                      hoverOrder && needed.has(entry.item_id) && "is-hit",
                      hoverOrder && !needed.has(entry.item_id) && "is-dim",
                    )}
                  >
                    <span aria-hidden="true">{itemEmoji(entry.item_id)}</span>
                    <i className="k-badge">{itemBadge(entry.item_id)}</i>
                    <b>×{entry.quantity}</b>
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className="k-tray" aria-label="排队中的动作">
            <h3 className="k-side-title">排队中 ({flow.queue.length})</h3>
            {flow.queue.length === 0 ? (
              <p className="k-muted">点工位开工、点小票交付；动作排在这里，下一拍自动执行。</p>
            ) : (
              <ul className="k-tray-list">
                {flow.queue.map((entry) => (
                  <li key={entry.action.action_id}>
                    <span>{entry.label}</span>
                    <button
                      type="button"
                      className="k-x"
                      aria-label={`取消 ${entry.label}`}
                      onClick={(event) => { releaseFocus(event); flow.dequeueAction(entry.action.action_id); }}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      {phase === "final" ? (
        <div className="k-settle-bar">
          <span className="k-muted">打烊时间到 —— 把还能交的订单交完，再结算。</span>
          <button
            type="button"
            className="k-cta"
            onClick={(event) => {
              releaseFocus(event);
              flow.settle();
            }}
          >
            打烊结算
          </button>
        </div>
      ) : null}

      {flow.banner ? (
        <div className={`k-banner is-${flow.banner.kind}`} role="status">
          {flow.banner.text}
        </div>
      ) : null}

      <ToastStack toasts={flow.toasts} onDismiss={flow.dismissToast} />
      <CoinBursts bursts={flow.bursts} />

      {openStation ? (
        <RecipePopover
          key={openStation}
          config={config}
          stationId={openStation}
          lots={lots}
          produced={produced}
          reservations={flow.reservations}
          onClose={closePopover}
          onStart={flow.queueStart}
        />
      ) : null}

      {phase === "briefing" ? <StartOverlay onStart={flow.openDay} /> : null}
    </div>
  );
}

function classList(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Rolls a money counter up to its new value; reduced motion flips at once. */
function useCountUp(target: number): number {
  const [shown, setShown] = useState(target);
  useEffect(() => {
    if (prefersReducedMotion() || target === shown) {
      setShown(target);
      return;
    }
    const from = shown;
    const started = performance.now();
    const span = 650;
    let frame = 0;
    const tick = (now: number): void => {
      const ratio = Math.min(1, (now - started) / span);
      const eased = 1 - (1 - ratio) ** 3;
      setShown(Math.round(from + (target - from) * eased));
      if (ratio < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // `shown` is the animation's own cursor, not an input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return shown;
}

/** A counter that changes whenever `value` does, to replay a CSS pop. */
function usePopKey(value: number): number {
  const [key, setKey] = useState(0);
  useEffect(() => setKey((current) => current + 1), [value]);
  return key;
}

const COINS_PER_BURST = 8;

/**
 * Coins flying from a paid ticket to the revenue counter. The trajectory is
 * computed once per burst in a layout effect (the counter may still be
 * settling), then handed to CSS as two custom properties.
 */
function CoinBursts({ bursts }: { bursts: readonly CoinBurst[] }): JSX.Element | null {
  const [target, setTarget] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (bursts.length === 0) return;
    const counter = document.querySelector<HTMLElement>(".k-revenue");
    const rect = counter?.getBoundingClientRect();
    setTarget({
      x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
      y: rect ? rect.top + rect.height / 2 : 40,
    });
  }, [bursts]);

  if (bursts.length === 0 || target === null || prefersReducedMotion()) return null;

  return (
    <>
      {bursts.map((burst) => (
        <span key={burst.id} aria-hidden="true">
          {Array.from({ length: COINS_PER_BURST }, (_, index) => (
            <span
              key={index}
              className="k-coin"
              style={
                {
                  "--x": `${burst.x}px`,
                  "--y": `${burst.y}px`,
                  "--dx": `${target.x - burst.x}px`,
                  "--dy": `${target.y - burst.y}px`,
                  "--i": index,
                } as Vars
              }
            >
              🪙
            </span>
          ))}
        </span>
      ))}
    </>
  );
}

/* --------------------------------- HUD ----------------------------------- */

function Hud({
  config,
  flow,
  onExit,
}: {
  config: PublicConfig;
  flow: GameFlow;
  onExit: () => void;
}): JSX.Element {
  const live = flow.phase === "running" || flow.phase === "paused";
  // A popover holds the flow too, and the button must say so — otherwise the
  // player sees a frozen clock next to a "▶ run" icon.
  const frozen = flow.phase === "paused" || flow.interacting;
  // The revenue rolls up to its new value and pops, so a payout is felt in the
  // HUD and not only on the ticket.
  const shownRevenue = useCountUp(flow.folded.revenueMinor);
  const revenuePop = usePopKey(flow.folded.revenueMinor);
  return (
    <header className="k-hud">
      <div className="k-hud-left">
        <span className="k-clock" ref={flow.clockRef} aria-label="营业时间">
          00:00.0
        </span>
        <div className="k-clock-wrap">
          <span className="k-clock-cap">/ {formatSimMs(config.end_at_ms)}</span>
          <div className="k-bar" role="progressbar" aria-label="一天进度">
            <i />
          </div>
        </div>
      </div>

      <div className="k-hud-mid">
        <span className="k-revenue" key={revenuePop}>
          <span aria-hidden="true">{COIN}</span> {formatMinor(shownRevenue)}
        </span>
        <span className="k-muted">已交付 {flow.folded.deliveredOrders} 单</span>
      </div>

      <div className="k-hud-right">
        <div className="k-speeds" role="group" aria-label="速度">
          {SPEEDS.map((speed: Speed) => (
            <button
              key={speed}
              type="button"
              aria-pressed={flow.speed === speed}
              className={classList("k-speed", flow.speed === speed && "is-on")}
              onClick={(event) => { releaseFocus(event); flow.setSpeed(speed); }}
            >
              {speed}×
            </button>
          ))}
        </div>
        <button
          type="button"
          className="k-icon-btn"
          aria-label={frozen ? "继续营业" : "暂停"}
          aria-pressed={frozen}
          disabled={!live}
          onClick={(event) => { releaseFocus(event); flow.togglePause(); }}
        >
          {frozen ? "▶" : "⏸"}
        </button>
        <button
          type="button"
          className="k-icon-btn"
          aria-label="单步推进"
          disabled={!live}
          onClick={(event) => { releaseFocus(event); flow.stepOnce(); }}
        >
          ⏭
        </button>
        <button type="button" className="k-icon-btn" aria-label="换个场景" onClick={(event) => { releaseFocus(event); onExit(); }}>
          ✕
        </button>
      </div>
    </header>
  );
}

/* ------------------------------- feedback -------------------------------- */

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: readonly Toast[];
  onDismiss: (id: number) => void;
}): JSX.Element {
  return (
    <div className="k-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className={`k-toast is-${toast.kind}`}
          onClick={(event) => { releaseFocus(event); onDismiss(toast.id); }}
        >
          {toast.text}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------- popover --------------------------------- */

function RecipePopover({
  config,
  stationId,
  lots,
  produced,
  reservations,
  onClose,
  onStart,
}: {
  config: PublicConfig;
  stationId: string;
  lots: readonly Lot[];
  produced: ReadonlySet<string>;
  reservations: ReadonlyMap<string, number>;
  onClose: () => void;
  onStart: (recipe: Recipe, stationId: string, batches: number) => boolean;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);


  const recipes = useMemo(
    () =>
      config.recipes.filter((recipe) =>
        recipe.station_options.some((option) => option.station_id === stationId),
      ),
    [config.recipes, stationId],
  );

  const optionOf = (recipe: Recipe): StationOption | undefined =>
    recipe.station_options.find((option) => option.station_id === stationId);

  /**
   * The most the pantry can actually feed this recipe right now. Starting at
   * the station's full capacity is what a player means by "fire up the fryer",
   * and a recipe whose inputs only cover one batch should not silently produce
   * a third of a load — hence the walk down from max_batches.
   */
  const affordableFor = (recipe: Recipe, max: number): number => {
    for (let batches = max; batches >= 1; batches -= 1) {
      if (planStartInputs(lots, recipe, batches, produced, reservations).complete) {
        return batches;
      }
    }
    return 1;
  };

  const activeRecipe = recipes.find((recipe) => recipe.id === selected) ?? recipes[0];
  const activeOption = activeRecipe ? optionOf(activeRecipe) : undefined;
  const maxBatches = activeOption?.max_batches ?? 1;
  const [batches, setBatches] = useState(() =>
    recipes[0] ? affordableFor(recipes[0], optionOf(recipes[0])?.max_batches ?? 1) : 1,
  );
  const steps = Math.max(1, Math.min(batches, maxBatches));
  const plan =
    activeRecipe && activeOption
      ? planStartInputs(lots, activeRecipe, steps, produced, reservations)
      : null;

  /**
   * Anchored to the tile, but measured rather than guessed.
   *
   * A guessed height is what put the CTA off-screen: the packager's card is
   * ~540px tall, so the old "+320 will fit" test said yes and dropped the
   * button 74px below a 900px fold. Now the panel is laid out first (hidden,
   * with `max-height` capping it to the viewport), then measured, then placed
   * below the tile — or flipped above it when it cannot fit — and clamped.
   */
  const place = useCallback((): void => {
    const panel = panelRef.current;
    const tile = document.querySelector<HTMLElement>(`[data-station-id="${stationId}"]`);
    if (!panel || !tile) return;
    const tileRect = tile.getBoundingClientRect();
    const margin = 12;
    const gap = 10;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = Math.max(margin, Math.min(window.innerWidth - width - margin, tileRect.left));
    const below = tileRect.bottom + gap;
    const above = tileRect.top - gap - height;
    const fitsBelow = below + height <= window.innerHeight - margin;
    const top = fitsBelow
      ? below
      : Math.max(margin, Math.min(above, window.innerHeight - height - margin));
    // Idempotent: re-anchoring to the same spot must not re-render, or a click
    // in flight sees the panel move out from under it.
    setAnchor((current) =>
      current !== null && Math.abs(current.top - top) < 0.5 && Math.abs(current.left - left) < 0.5
        ? current
        : { top, left },
    );
  }, [stationId]);

  useLayoutEffect(() => {
    place();
    // The panel's height is not fixed: a card gains or loses its "缺 …" line as
    // the pantry fills, which slides the footer. Re-anchor on every resize so a
    // flipped-above popover can never creep back over the top edge.
    const panel = panelRef.current;
    const observer =
      panel && typeof ResizeObserver === "function" ? new ResizeObserver(() => place()) : null;
    observer?.observe(panel as HTMLElement);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [place]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (!panelRef.current?.contains(target)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className={anchor === null ? "k-popover is-measuring" : "k-popover"}
      role="dialog"
      aria-label={`${stationLabel(stationId)} 开工菜单`}
      style={anchor === null ? undefined : { top: anchor.top, left: anchor.left }}
    >
      <div className="k-pop-head">
        <span className="k-pop-title">
          <span aria-hidden="true">{stationEmoji(stationId)}</span> {stationLabel(stationId)}
        </span>
        <button type="button" className="k-x" aria-label="关闭" onClick={(event) => { releaseFocus(event); onClose(); }}>
          ✕
        </button>
      </div>
      <p className="k-muted small">⏸ 时间已暂停 —— 想好了再开工。</p>

      <ul className="k-recipe-list">
        {recipes.map((recipe) => {
          const option = optionOf(recipe);
          const max = option?.max_batches ?? 1;
          // One batch is the minimum the player can pick, so a recipe that
          // fails here can never be run at any batch size.
          const preview = planStartInputs(lots, recipe, 1, produced, reservations);
          const missing = preview.missing
            .map((line) => `${itemLabel(line.item_id)}×${line.quantity}`)
            .join("、");
          return (
            <li key={recipe.id}>
              <button
                type="button"
                aria-pressed={activeRecipe?.id === recipe.id}
                className={classList(
                  "k-recipe",
                  activeRecipe?.id === recipe.id && "is-on",
                  !preview.complete && "is-short",
                )}
                onClick={() => {
                  setSelected(recipe.id);
                  setBatches(affordableFor(recipe, max));
                }}
              >
                <span className="k-recipe-emoji" aria-hidden="true">
                  {recipeEmoji(recipe.id)}
                </span>
                <span className="k-recipe-main">
                  <b>{recipeLabel(recipe.id)}</b>
                  <span className="k-muted small">
                    {recipe.inputs.map((line) => itemLabel(line.item_id)).join(" + ")} →{" "}
                    {recipe.outputs.map((line) => itemLabel(line.item_id)).join(" + ")}
                  </span>
                </span>
                <span className="k-recipe-meta small">
                  {option ? `${formatSimMs(option.duration_ms)} 固定` : "—"}
                  <br />最多 {max} 批
                </span>
                {!preview.complete ? <span className="k-recipe-missing">缺 {missing}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="k-pop-foot">
        <div className="k-stepper" aria-label="批次">
          <button
            type="button"
            className="k-step"
            aria-label="减少批次"
            disabled={steps <= 1}
            onClick={() => setBatches((value) => Math.max(1, value - 1))}
          >
            −
          </button>
          <span className="k-step-value">
            <b>{steps}</b> 批
          </span>
          <button
            type="button"
            className="k-step"
            aria-label="增加批次"
            disabled={steps >= maxBatches}
            onClick={() => setBatches((value) => Math.min(maxBatches, value + 1))}
          >
            ＋
          </button>
        </div>

        <button
          type="button"
          className="k-cta wide"
          disabled={!activeRecipe || !plan?.complete}
          onClick={(event) => {
            releaseFocus(event);
            if (!activeRecipe) return;
            if (onStart(activeRecipe, stationId, steps)) onClose();
          }}
        >
          开工 {activeRecipe ? recipeLabel(activeRecipe.id) : ""}
        </button>
      </div>
    </div>
  );
}

/* -------------------------------- overlays ------------------------------- */

function StartOverlay({ onStart }: { onStart: () => void }): JSX.Element {
  return (
    <div className="k-overlay" role="dialog" aria-label="开始营业">
      <div className="k-overlay-card">
        <span className="k-overlay-emoji" aria-hidden="true">
          🍟
        </span>
        <h2>今天开张！</h2>
        <p className="k-muted">点工位开工，点小票交付。整单交付才有钱，订单不会过期。</p>
        <button type="button" className="k-cta big" onClick={(event) => { releaseFocus(event); onStart(); }}>
          ▶ 开始营业
        </button>
      </div>
    </div>
  );
}
