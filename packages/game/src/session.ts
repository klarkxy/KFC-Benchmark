import { Kernel } from "@kitchensched/core";
import type { RunOutput } from "@kitchensched/core";
import type {
  ControllerModule,
  Decision,
  EventRecord,
  Id,
  Observation,
  Order,
  PublicConfig,
  ReplayFile,
} from "@kitchensched/contracts";

import { createActionIdFactory } from "./helpers.js";
import { buildReplayFile, type ReplayMeta } from "./replay.js";

/**
 * A browser-playable game session: the real deterministic kernel, stepped one
 * human decision at a time. No wall clock, no controller, no host — a session
 * is just a paused kernel plus the bookkeeping a UI needs.
 */

/** The kernel demands a ControllerModule; interactive mode never calls it. */
const NEVER_CONSULTED: ControllerModule = {
  init(): void {
    throw new Error("@kitchensched/game: an interactive session never inits a controller");
  },
  decide(): never {
    throw new Error("@kitchensched/game: an interactive session never asks a controller to decide");
  },
};

export interface GameSessionOptions {
  /** The frozen public kitchen config of the scenario being played. */
  config: PublicConfig;
  /** Full pre-generated order trajectory, sorted by arrived_at_ms. */
  orders: Order[];
  /** Recorded with the run; interactive mode draws no random numbers from it. */
  policy_seed?: number;
}

export type SubmitResult =
  | {
      ok: true;
      /** Records emitted by this step, in seq order. */
      events: readonly EventRecord[];
      /** The next observation, or null once the run is over. */
      observation: Observation | null;
      /** The final RunOutput, or null while the session is still running. */
      done: RunOutput | null;
    }
  | { ok: false; reason: string };

export interface GameSession {
  readonly config: PublicConfig;
  readonly orders: readonly Order[];
  /** The decision the player owes right now; null once the run is over. */
  readonly observation: Observation | null;
  /** The final RunOutput; null while the session is still running. */
  readonly done: RunOutput | null;
  readonly finished: boolean;
  /** Every event emitted so far, in seq order. */
  readonly events: readonly EventRecord[];
  /** Unique `a-<n>` id for the next action (the kernel dedupes by action_id). */
  nextActionId(): Id;
  submit(decision: Decision): SubmitResult;
  /** Replay file in the host's shape, for download or in-page playback. */
  replayFile(meta: ReplayMeta): ReplayFile;
}

class KernelGameSession implements GameSession {
  readonly config: PublicConfig;
  readonly orders: Order[];
  readonly events: EventRecord[] = [];

  private readonly kernel: Kernel;
  private readonly nextId: () => Id;
  private current: Observation | null = null;
  private output: RunOutput | null = null;

  constructor(opts: GameSessionOptions) {
    this.config = opts.config;
    this.orders = [...opts.orders];
    this.nextId = createActionIdFactory();
    this.kernel = new Kernel({
      config: opts.config,
      orderStream: this.orders,
      controller: NEVER_CONSULTED,
      policy_seed: opts.policy_seed ?? 0,
    });
    const first = this.kernel.beginInteractive();
    if (first.kind !== "observation") {
      throw new Error(`createGameSession: the session could not start (${first.kind})`);
    }
    this.absorb(first.events);
    this.current = first.observation;
  }

  get observation(): Observation | null {
    return this.current;
  }

  get done(): RunOutput | null {
    return this.output;
  }

  get finished(): boolean {
    return this.output !== null;
  }

  nextActionId(): Id {
    return this.nextId();
  }

  submit(decision: Decision): SubmitResult {
    if (this.output !== null) {
      return { ok: false, reason: "the session is already finished" };
    }
    const step = this.kernel.advanceInteractive(decision);
    if (step.kind === "invalid") return { ok: false, reason: step.reason };
    this.absorb(step.events);
    this.current = step.kind === "observation" ? step.observation : null;
    if (step.kind === "done") this.output = step.output;
    return { ok: true, events: step.events, observation: this.current, done: this.output };
  }

  replayFile(meta: ReplayMeta): ReplayFile {
    return buildReplayFile(this.config, meta, this.events);
  }

  private absorb(events: readonly EventRecord[]): void {
    for (const event of events) this.events.push(event);
  }
}

/** Starts a session paused at the t=0 observation. */
export function createGameSession(opts: GameSessionOptions): GameSession {
  return new KernelGameSession(opts);
}
