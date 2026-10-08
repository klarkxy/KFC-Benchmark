import type { Action, ActionResult, LotQty, Observation } from "@kitchensched/game";
import type { ActionCode } from "@kitchensched/contracts";

import type { ReplayEvent } from "../replay/reducer";

/**
 * Real-time flow engine for `#/play/<tier>`.
 *
 * The kernel is still the single source of truth and still pauses at every
 * decision point — nothing here simulates the world. What this module owns is
 * the *pacing*:
 *
 *   1. `queue*` — the player's intent tray. Actions fire at the next decision
 *      boundary, and the shared reservation accumulator makes it impossible
 *      for two queued actions to spend the same lot.
 *   2. `decisionFor` — what to hand the kernel: the whole queue, or an empty
 *      decision (a bare clock advance) when the player queued nothing.
 *   3. `SimTween` — one rAF loop per step that interpolates the simulation
 *      clock from the previous decision point to the next and reveals that
 *      step's events exactly as the animated clock passes them.
 *
 * Everything except `SimTween` is pure, so the queue/reservation arithmetic is
 * unit-tested without a session (see site/tests/engine.test.ts).
 */

/** Simulated milliseconds per real second at 1x speed. */
export const BASE_SIM_PER_REAL_SECOND = 6;

/**
 * Ceiling on one step's tween. A public stream can leave minutes of silence
 * between decision points (the easy practice stream's first order lands at
 * t=60s), and animating that literally would open the game with ten dead
 * seconds of an empty kitchen. Long gaps are compressed; the short beats that
 * carry the action keep their true length.
 */
export const MAX_STEP_REAL_MS = 3000;

export const SPEEDS = [0.5, 1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

/* ------------------------------ the queue -------------------------------- */

export interface QueuedAction {
  action: Action;
  /** The lots this action promised; the reservation accumulator is their sum. */
  lots: readonly LotQty[];
  /** Player-facing description, reused by toasts and stamps. */
  label: string;
}

/**
 * Sums what the queue has already promised, per lot. Feed it back into
 * `planStartInputs` / `planDeliverOutputs` so a queued action can never plan
 * against stock another queued action already took.
 */
export function reservationsOf(queue: readonly QueuedAction[]): Map<string, number> {
  const reserved = new Map<string, number>();
  for (const entry of queue) {
    for (const lot of entry.lots) {
      reserved.set(lot.lot_id, (reserved.get(lot.lot_id) ?? 0) + lot.quantity);
    }
  }
  return reserved;
}

export function enqueue(
  queue: readonly QueuedAction[],
  entry: QueuedAction,
): QueuedAction[] {
  return [...queue, entry];
}

/** Drops one queued action and immediately frees whatever it had reserved. */
export function dequeue(
  queue: readonly QueuedAction[],
  actionId: string,
): QueuedAction[] {
  return queue.filter((entry) => entry.action.action_id !== actionId);
}

export function queuedStationIds(queue: readonly QueuedAction[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of queue) {
    if (entry.action.type === "start") ids.add(entry.action.station_id);
  }
  return ids;
}

export function queuedOrderIds(queue: readonly QueuedAction[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of queue) {
    if (entry.action.type === "deliver") ids.add(entry.action.order_id);
  }
  return ids;
}

/**
 * The decision handed to `session.submit`. The queue is consumed: its actions
 * belong to this boundary and must not be replayed at the next one (the kernel
 * dedupes by `action_id` and would answer ACTION_ID_CONFLICT).
 */
export function decisionFor(queue: readonly QueuedAction[]): {
  actions: Action[];
  wake_at_ms: null;
} {
  return { actions: queue.map((entry) => entry.action), wake_at_ms: null };
}

/** action_id -> label, so a rejection can be reported in the player's words. */
export function labelsOf(queue: readonly QueuedAction[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const entry of queue) labels[entry.action.action_id] = entry.label;
  return labels;
}

/* ---------------------------- step geometry ------------------------------ */

export interface StepWindow {
  fromMs: number;
  toMs: number;
}

/**
 * The window one submitted decision opened: from the decision point the player
 * acted at, to the next decision point the kernel parked on. When the run ends
 * (`observation === null`) the last event carries the end of the day.
 */
export function stepWindow(
  fromMs: number,
  events: readonly ReplayEvent[],
  nextNowMs: number | null,
): StepWindow {
  let toMs = fromMs;
  for (const event of events) {
    if (event.at_ms > toMs) toMs = event.at_ms;
  }
  if (nextNowMs !== null && nextNowMs > toMs) toMs = nextNowMs;
  return { fromMs, toMs };
}

/** Real milliseconds the tween takes at `speed`. */
export function durationRealMs(window: StepWindow, speed: Speed): number {
  const span = window.toMs - window.fromMs;
  if (span <= 0) return 0;
  return Math.min(span / (BASE_SIM_PER_REAL_SECOND * speed), MAX_STEP_REAL_MS);
}

/** Sim clock at `elapsedRealMs` into the tween. Linear: a sim clock that eases
 *  would make arrival times unreadable, so the bounce lives in the visuals. */
export function simTimeAt(
  window: StepWindow,
  elapsedRealMs: number,
  speed: Speed,
): number {
  const duration = durationRealMs(window, speed);
  if (duration <= 0) return window.toMs;
  const ratio = Math.max(0, Math.min(1, elapsedRealMs / duration));
  return window.fromMs + (window.toMs - window.fromMs) * ratio;
}

/** How many of a step's events the animated clock has passed. */
export function revealedCount(
  events: readonly ReplayEvent[],
  simNowMs: number,
  already: number,
): number {
  let count = already;
  while (count < events.length && (events[count]?.at_ms ?? Infinity) <= simNowMs) count += 1;
  return count;
}

/* ------------------------------ the tween -------------------------------- */

export interface TweenHooks {
  /** Every frame: the interpolated sim clock. Must stay cheap (DOM refs). */
  onFrame: (simNowMs: number) => void;
  /** Discrete world change: the events that just landed. */
  onReveal: (events: readonly ReplayEvent[], simNowMs: number) => void;
  /** The window is fully animated; the caller may submit the next decision. */
  onFinish: (simNowMs: number) => void;
}

const nowReal = (): number =>
  typeof performance === "undefined" ? Date.now() : performance.now();

/**
 * One rAF loop per submitted decision.
 *
 * The clock is never a React value: `onFrame` writes a CSS custom property and
 * a text node, so a 4x day ticking 300 simulated seconds costs zero re-renders.
 * Discrete things (a ticket landing, a task finishing) go through `onReveal`,
 * which fires once per event, not once per frame.
 */
export class SimTween {
  private window: StepWindow = { fromMs: 0, toMs: 0 };
  private events: readonly ReplayEvent[] = [];
  private revealed = 0;
  private elapsed = 0;
  private lastFrame = 0;
  private speed: Speed = 1;
  private frame = 0;
  private finishing = false;
  private active = false;

  constructor(private readonly hooks: TweenHooks) {}

  get current(): StepWindow {
    return this.window;
  }

  get revealedCount(): number {
    return this.revealed;
  }

  /** True while a window is being animated (started, not yet finished). */
  get inFlight(): boolean {
    return this.active;
  }

  setSpeed(speed: Speed): void {
    // Elapsed real time is preserved; only the remaining duration changes.
    this.speed = speed;
  }

  start(window: StepWindow, events: readonly ReplayEvent[]): void {
    this.cancel();
    this.window = window;
    this.events = events;
    this.revealed = 0;
    this.elapsed = 0;
    this.finishing = false;
    this.active = true;
    this.lastFrame = nowReal();
    // Always async, even for a zero-length window: `onFinish` submits the next
    // decision, and a synchronous chain would recurse through the whole day.
    this.frame = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (this.frame === 0) return;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  resume(): void {
    if (this.frame !== 0 || this.finishing || !this.active) return;
    this.lastFrame = nowReal();
    this.frame = requestAnimationFrame(this.tick);
  }

  /** Jump to the end of the current window (the ⏭ button while paused). */
  skip(): void {
    if (!this.active || this.finishing) return;
    this.elapsed = Number.POSITIVE_INFINITY;
    this.complete();
  }

  cancel(): void {
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private readonly tick = (): void => {
    this.frame = 0;
    const real = nowReal();
    this.elapsed += real - this.lastFrame;
    this.lastFrame = real;
    if (this.elapsed >= durationRealMs(this.window, this.speed)) {
      this.complete();
      return;
    }
    this.paint(simTimeAt(this.window, this.elapsed, this.speed));
    this.frame = requestAnimationFrame(this.tick);
  };

  private paint(simNowMs: number): void {
    this.hooks.onFrame(simNowMs);
    const next = revealedCount(this.events, simNowMs, this.revealed);
    if (next === this.revealed) return;
    const landed = this.events.slice(this.revealed, next);
    this.revealed = next;
    this.hooks.onReveal(landed, simNowMs);
  }

  private complete(): void {
    if (this.finishing) return;
    this.finishing = true;
    this.active = false;
    this.cancel();
    this.paint(this.window.toMs);
    this.hooks.onFinish(this.window.toMs);
  }
}

/* ------------------------------- feedback -------------------------------- */

export interface Toast {
  id: number;
  kind: "ok" | "bad" | "info";
  text: string;
}

/** Rejections the kernel answers with, in the player's language. */
export function rejectionToasts(
  results: readonly ActionResult[],
  labels: Readonly<Record<string, string>>,
  reasons: (code: ActionCode) => string,
  offset: number,
): Toast[] {
  return results
    .filter((result) => !result.ok)
    .map((result, index) => ({
      id: offset + index,
      kind: "bad" as const,
      text: `${labels[result.action_id] ?? result.action_id}：${reasons(result.code)}`,
    }));
}

/** Observation the engine must respect: the endgame takes no auto-advance. */
export function isEndgame(observation: Observation | null): boolean {
  return observation !== null && observation.final;
}
