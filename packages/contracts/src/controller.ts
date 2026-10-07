import type { Decision, Observation, PublicConfig } from "./types.js";

/**
 * Deterministic random source injected by the host.
 * Backed by mulberry32(policy_seed); identical sequence in CI and browser.
 * Candidates MUST use ctx.random() instead of Math.random().
 */
export type Rng = () => number;

export interface InitContext {
  /** Seed for ctx.random(); also recorded in the run meta. */
  policy_seed: number;
  random: Rng;
}

/**
 * The single-file submission contract (protocol 0.3.0-web).
 *
 * A submission is one dependency-free TypeScript module whose default
 * export satisfies this interface. `import type` from
 * "@kitchensched/contracts" is allowed (types are erased); runtime
 * imports are not.
 */
export interface ControllerModule {
  /**
   * Called once per run with the full static public config.
   * Must not change the world; the first observation arrives at t=0.
   */
  init(config: PublicConfig, ctx: InitContext): void;
  /**
   * Called once per observation. The simulation clock is paused while
   * this runs, but a real wall-clock budget (limits.decision_wall_ms)
   * applies. Must return synchronously.
   */
  decide(observation: Observation): Decision;
}

/** Shape check used by the host before a run. */
export function isControllerModule(mod: unknown): mod is ControllerModule {
  const m = mod as { default?: Partial<ControllerModule> } | null;
  const d = m?.default ?? (m as Partial<ControllerModule> | null);
  return (
    !!d &&
    typeof d.init === "function" &&
    typeof d.decide === "function"
  );
}
