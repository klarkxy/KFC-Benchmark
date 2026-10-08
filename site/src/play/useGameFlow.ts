import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  planDeliverOutputs,
  planStartInputs,
  producedItemIds,
  type EventRecord,
  type GameSession,
  type Lot,
  type Observation,
  type Order,
  type Recipe,
  type RunOutput,
} from "@kitchensched/game";

import { formatSimMs } from "../lib/format";
import { recipeLabel, stationLabel } from "../lib/labels";
import {
  applyEvent,
  createInitialState,
  seedStations,
  withCursor,
  type ReplayEvent,
  type ReplayState,
} from "../replay/reducer";
import {
  dequeue,
  decisionFor,
  enqueue,
  labelsOf,
  queuedOrderIds,
  queuedStationIds,
  reservationsOf,
  rejectionToasts,
  SimTween,
  type QueuedAction,
  type Speed,
  type Toast,
} from "./engine";
import { actionCodeReason } from "./reasons";

/**
 * React binding for the auto-flow engine.
 *
 * The one invariant worth stating: the kernel applies a whole decision at a
 * time, and the player always acts while it is parked on an observation. So
 * actions are planned against THAT observation, never against the animation:
 * the folded event stream lags by up to one step, and a lot the rail still
 * shows may already have been consumed by the step being animated — planning
 * on the display state would spend phantom stock (UNKNOWN_LOT at submit).
 * The fold drives what you SEE (which tickets landed, what is cooking); the
 * observation drives what you can DO.
 *
 * Frames never touch React: `onFrame` writes one CSS variable plus one text
 * node. Only discrete events (a ticket landing, a task finishing, a delivery
 * paying out) re-render.
 */

export type Phase = "briefing" | "running" | "paused" | "final" | "over";

export interface BannerState {
  text: string;
  kind: "open" | "final";
}

export interface DeliveredTicket {
  order: Order;
  valueMinor: number;
}

/** A coin flying from a paid ticket to the revenue counter. */
export interface CoinBurst {
  id: number;
  orderId: string;
  x: number;
  y: number;
}

export interface GameFlow {
  folded: ReplayState;
  /**
   * The kernel's parked observation: what the player may act on right now.
   * Authoritative where `folded` is only a picture.
   */
  observation: Observation | null;
  /** Same observation, pre-split for convenience. */
  stock: readonly Lot[];
  openOrders: readonly Order[];
  queue: readonly QueuedAction[];
  reservations: ReadonlyMap<string, number>;
  phase: Phase;
  /** True while a popover holds the flow (the player is thinking). */
  interacting: boolean;
  speed: Speed;
  toasts: readonly Toast[];
  banner: BannerState | null;
  delivered: readonly DeliveredTicket[];
  /** Live coin bursts, emitted the instant the kernel pays out. */
  bursts: readonly CoinBurst[];
  done: RunOutput | null;
  rootRef: React.RefObject<HTMLDivElement>;
  clockRef: React.RefObject<HTMLSpanElement>;
  openDay: () => void;
  togglePause: () => void;
  stepOnce: () => void;
  setSpeed: (speed: Speed) => void;
  /** A popover is open: the flow waits so the player is never rushed. */
  setInteracting: (value: boolean) => void;
  queueStart: (recipe: Recipe, stationId: string, batches: number) => boolean;
  queueDeliver: (order: Order) => boolean;
  /** An impossible tap: shake the target and say exactly what is missing. */
  notifyMissing: (missing: string) => void;
  dequeueAction: (actionId: string) => void;
  settle: () => void;
  dismissToast: (id: number) => void;
}

const asReplayEvents = (events: readonly EventRecord[]): readonly ReplayEvent[] =>
  events as readonly ReplayEvent[];

/** Folds the first `count` events of a session into the display world. */
function foldUpTo(session: GameSession, count: number): ReplayState {
  let state = seedStations(createInitialState(), session.config);
  for (const event of asReplayEvents(session.events.slice(0, count))) {
    state = applyEvent(state, event);
  }
  return withCursor(state, state.nowMs);
}

export function useGameFlow(session: GameSession): GameFlow {
  const [landed, setLanded] = useState(0);
  const [observation, setObservation] = useState<Observation | null>(session.observation);
  const [queue, setQueue] = useState<QueuedAction[]>([]);
  const [phase, setPhase] = useState<Phase>("briefing");
  const [interacting, setInteractingState] = useState(false);
  const [speed, setSpeedState] = useState<Speed>(1);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [banner, setBanner] = useState<BannerState | null>(null);
  const [delivered, setDelivered] = useState<DeliveredTicket[]>([]);
  const [bursts, setBursts] = useState<CoinBurst[]>([]);
  const [done, setDone] = useState<RunOutput | null>(null);

  const sessionRef = useRef(session);
  sessionRef.current = session;

  const landedRef = useRef(0);
  const queueRef = useRef<QueuedAction[]>([]);
  const phaseRef = useRef<Phase>("briefing");
  const awaitingRef = useRef(false);
  const interactingRef = useRef(false);
  const toastIdRef = useRef(0);
  const burstIdRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);

  const folded = useMemo(() => foldUpTo(session, landed), [session, landed]);
  const stock = observation?.inventory ?? [];
  const openOrders = observation?.orders ?? [];

  const reservations = useMemo(() => reservationsOf(queue), [queue]);

  // The planners must read the latest observation, not a captured one.
  const stockRef = useRef<readonly Lot[]>(stock);
  stockRef.current = stock;

  const ordersById = useMemo(
    () => new Map(session.orders.map((order) => [order.id, order] as const)),
    [session],
  );

  const pushToast = useCallback((kind: Toast["kind"], text: string): void => {
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToasts((current) => [...current.slice(-3), { id, kind, text }]);
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 3400);
  }, []);

  const showBanner = useCallback((next: BannerState, ms: number): void => {
    setBanner(next);
    window.setTimeout(() => setBanner((current) => (current === next ? null : current)), ms);
  }, []);

  /**
   * Money made loud. Fired from the `order_delivered` event rather than from
   * the click that queued the delivery: the queue itself cannot be rejected
   * (plans are read off the parked observation and the reservation
   * accumulator keeps them disjoint), but the cash does not land until the
   * next decision boundary, up to a few hundred ms later. Event-time is the
   * only moment where "coins fly" and "revenue went up" are the same instant.
   */
  const burstFrom = useCallback((orderId: string): void => {
    const ticket = document.querySelector<HTMLElement>(`[data-order-id="${orderId}"]`);
    const rect = ticket?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const y = rect ? rect.top + rect.height / 2 : 80;
    setBursts((current) => {
      const next = [...current, { id: ++burstIdRef.current, orderId, x, y }];
      // one live burst at a time keeps the rail readable
      return next.slice(-1);
    });
    const id = burstIdRef.current;
    window.setTimeout(() => setBursts((current) => current.filter((b) => b.id !== id)), 1400);
  }, []);

  const reportRejections = useCallback(
    (results: Parameters<typeof rejectionToasts>[0], labels: Record<string, string>) => {
      for (const toast of rejectionToasts(
        results,
        labels,
        actionCodeReason,
        toastIdRef.current + 1000,
      )) {
        toastIdRef.current = Math.max(toastIdRef.current, toast.id);
        pushToast(toast.kind, toast.text);
      }
    },
    [pushToast],
  );

  /* ------------------------------ the engine ----------------------------- */

  const onFrame = (simNow: number): void => {
    const root = rootRef.current;
    if (root) root.style.setProperty("--sim-now", String(Math.round(simNow)));
    const clock = clockRef.current;
    if (clock) clock.textContent = formatSimMs(simNow);
  };

  const onReveal = (landedEvents: readonly ReplayEvent[]): void => {
    landedRef.current += landedEvents.length;
    setLanded(landedRef.current);
    for (const event of landedEvents) {
      if (event.type === "order_arrived") {
        pushToast("info", `🔔 新订单 ${event.payload.order.id} 到了`);
      } else if (event.type === "task_completed") {
        pushToast("ok", `叮！${recipeLabel(event.payload.task.recipe_id)} 出锅了`);
      } else if (event.type === "order_delivered") {
        const order = ordersById.get(event.payload.order_id);
        if (order) {
          setDelivered((current) => [...current, { order, valueMinor: event.payload.value_minor }]);
          window.setTimeout(
            () =>
              setDelivered((current) => current.filter((entry) => entry.order.id !== order.id)),
            1200,
          );
        }
        // The coins leave from the ticket that just got stamped. Reading the
        // rect here (before React re-renders) is the only moment the ticket is
        // guaranteed to be exactly where the player last saw it.
        burstFrom(event.payload.order_id);
        pushToast(
          "ok",
          `🪙 交付 ${event.payload.order_id}：+${(event.payload.value_minor / 100).toFixed(2)}`,
        );
      } else if (event.type === "action_rejected") {
        const rejected = event.payload.result;
        pushToast("bad", `${rejected.action_id}：${actionCodeReason(rejected.code)}`);
      }
    }
  };

  const onFinish = (): void => {
    const current = sessionRef.current;
    if (current.finished) {
      phaseRef.current = "over";
      setPhase("over");
      setDone(current.done);
      return;
    }
    if (current.observation?.final) {
      phaseRef.current = "final";
      setPhase("final");
      showBanner({ text: "最后交付！", kind: "final" }, 2600);
      return;
    }
    awaitingRef.current = true;
    pump();
  };

  const tweenRef = useRef<SimTween | null>(null);
  if (tweenRef.current === null) {
    tweenRef.current = new SimTween({ onFrame, onReveal, onFinish });
  }
  const tween = tweenRef.current;

  /** Submits one decision: the whole queue, or a bare clock advance. */
  function submitNext(): void {
    const current = sessionRef.current;
    const observation = current.observation;
    if (!observation || current.finished || observation.final) return;
    const batch = queueRef.current;
    queueRef.current = [];
    setQueue([]);
    const labels = labelsOf(batch);
    const result = current.submit(decisionFor(batch));
    if (!result.ok) {
      pushToast("bad", `内核拒绝了这次提交：${result.reason}`);
      return;
    }
    reportRejections(result.observation?.previous_results ?? [], labels);
    setObservation(result.observation);
    let toMs = observation.now_ms;
    for (const event of result.events) {
      if (event.at_ms > toMs) toMs = event.at_ms;
    }
    if (result.observation !== null && result.observation.now_ms > toMs) {
      toMs = result.observation.now_ms;
    }
    tween.start({ fromMs: observation.now_ms, toMs }, asReplayEvents(result.events));
  }

  /** Starts the next decision as soon as nothing is blocking it. */
  function pump(): void {
    if (!awaitingRef.current) return;
    if (phaseRef.current !== "running" || interactingRef.current) return;
    awaitingRef.current = false;
    submitNext();
  }

  function syncFlow(): void {
    if (phaseRef.current === "running" && !interactingRef.current) {
      tween.resume();
      pump();
    } else {
      tween.pause();
    }
  }

  /* ------------------------------- controls ------------------------------ */

  const openDay = useCallback(() => {
    if (phaseRef.current !== "briefing") return;
    phaseRef.current = "running";
    setPhase("running");
    showBanner({ text: "开门营业！", kind: "open" }, 2200);
    awaitingRef.current = true;
    pump();
  }, [showBanner]);

  const togglePause = useCallback(() => {
    const current = phaseRef.current;
    if (current === "briefing" || current === "final" || current === "over") return;
    phaseRef.current = current === "paused" ? "running" : "paused";
    setPhase(phaseRef.current);
    syncFlow();
  }, []);

  const stepOnce = useCallback(() => {
    tween.skip();
  }, [tween]);

  const setSpeed = useCallback(
    (next: Speed) => {
      setSpeedState(next);
      tween.setSpeed(next);
    },
    [tween],
  );

  const setInteracting = useCallback((value: boolean) => {
    interactingRef.current = value;
    setInteractingState(value);
    syncFlow();
  }, []);

  const queueStart = useCallback(
    (recipe: Recipe, stationId: string, batches: number): boolean => {
      const current = sessionRef.current;
      if (current.observation?.final) return false;
      if (queuedStationIds(queueRef.current).has(stationId)) return false;
      const plan = planStartInputs(
        stockRef.current,
        recipe,
        batches,
        producedItemIds(current.config),
        reservationsOf(queueRef.current),
      );
      if (!plan.complete) return false;
      const entry: QueuedAction = {
        action: {
          type: "start",
          action_id: current.nextActionId(),
          recipe_id: recipe.id,
          station_id: stationId,
          batches,
          input_lots: [...plan.lots],
        },
        lots: plan.lots,
        label: `开工 ${recipeLabel(recipe.id)} ×${batches} @ ${stationLabel(stationId)}`,
      };
      queueRef.current = enqueue(queueRef.current, entry);
      setQueue(queueRef.current);
      pushToast("info", `已排队 ${entry.label}`);
      return true;
    },
    [pushToast],
  );

  const queueDeliver = useCallback(
    (order: Order): boolean => {
      const current = sessionRef.current;
      if (queuedOrderIds(queueRef.current).has(order.id)) return false;
      const plan = planDeliverOutputs(
        stockRef.current,
        order,
        reservationsOf(queueRef.current),
      );
      if (!plan.complete) return false;
      const entry: QueuedAction = {
        action: {
          type: "deliver",
          action_id: current.nextActionId(),
          order_id: order.id,
          output_lots: [...plan.lots],
        },
        lots: plan.lots,
        label: `交付 ${order.id}`,
      };
      queueRef.current = enqueue(queueRef.current, entry);
      setQueue(queueRef.current);
      pushToast("info", `已排队 交付 ${order.id}`);
      return true;
    },
    [pushToast],
  );

  const dequeueAction = useCallback((actionId: string) => {
    queueRef.current = dequeue(queueRef.current, actionId);
    setQueue(queueRef.current);
  }, []);

  const notifyMissing = useCallback(
    (missing: string) => {
      pushToast("bad", `还差：${missing}`);
    },
    [pushToast],
  );

  /** The endgame decision: submit whatever is queued and close the books. */
  const settle = useCallback(() => {
    const current = sessionRef.current;
    const observation = current.observation;
    if (!observation?.final) return;
    tween.pause();
    const batch = queueRef.current;
    const labels = labelsOf(batch);
    const result = current.submit(decisionFor(batch));
    if (!result.ok) {
      pushToast("bad", `内核拒绝了收尾：${result.reason}`);
      return;
    }
    reportRejections(result.done?.result.final_action_results ?? [], labels);
    queueRef.current = [];
    setQueue([]);
    landedRef.current += result.events.length;
    setLanded(landedRef.current);
    onFrame(observation.now_ms);
    phaseRef.current = "over";
    setPhase("over");
    setDone(result.done);
  }, [onFrame, pushToast, reportRejections, tween]);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  useEffect(() => () => tween.cancel(), [tween]);

  return {
    folded,
    observation,
    stock,
    openOrders,
    queue,
    reservations,
    phase,
    interacting,
    speed,
    toasts,
    banner,
    delivered,
    bursts,
    done,
    rootRef,
    clockRef,
    openDay,
    togglePause,
    stepOnce,
    setSpeed,
    setInteracting,
    queueStart,
    queueDeliver,
    notifyMissing,
    dequeueAction,
    settle,
    dismissToast,
  };
}
