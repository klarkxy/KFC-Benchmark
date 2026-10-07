import { runScenario, sha256Hex, verifyRun } from "@kitchensched/core";
import type { RunOutput } from "@kitchensched/core";
import {
  canonicalSerialize,
  type ControllerModule,
  type Difficulty,
  type EndResult,
  type EventRecord,
  type SubmissionMeta,
} from "@kitchensched/contracts";

import { slugifyLabel } from "./loader.js";
import type { StreamCase } from "./scenarios.js";

/**
 * The host runner: submission x scenario matrix through the deterministic
 * kernel, with the independent judge as the integrity gate.
 *
 * Failure taxonomy (doc 05 §4):
 *  - `candidate_failed` — the kernel encoded a protocol/budget violation.
 *    That is the candidate's fault and scores 0.
 *  - `infra_failed` — something the host or the judge owns went wrong:
 *    an exception out of the kernel, or a judge/ledger disagreement. The run
 *    blocks leaderboard publication and the CLI exits non-zero.
 */

export const ENGINE_VERSION = "core/0.3.0";

/** Deterministic per-run policy seed, so a run never depends on process state. */
export function policySeedFor(run_id: string): number {
  return Number.parseInt(sha256Hex(run_id).slice(0, 8), 16) >>> 0;
}

/** sha256 of the canonical public config; binds a run to the exact scenario bytes. */
export function scenarioHashFor(config: unknown): string {
  return sha256Hex(canonicalSerialize(config));
}

export function runIdFor(
  model_label: string,
  generation: number,
  difficulty: Difficulty,
  stream_tag: string,
): string {
  return `${slugifyLabel(model_label)}-gen${generation}-${difficulty}-${stream_tag}`;
}

export interface RunOutcome {
  run_id: string;
  benchmark_version: string;
  difficulty: Difficulty;
  scenario_id: string;
  scenario_hash: string;
  submission: SubmissionMeta;
  result: EndResult;
  state_hash: string;
  replay_kind: "practice" | "scoring";
  events: EventRecord[];
  policy_seed: number;
  order_count: number;
  book_value_minor: number;
  judge_ok: boolean;
  judge_mismatches: string[];
  wall: { decisions: number; total_actions: number; duration_ms: number };
  finished_at_iso: string;
  infra_alarm: string | null;
}

export interface RunSpec {
  benchmark_version: string;
  submission: SubmissionMeta;
  /** Imports a fresh module instance; `freshKey` isolates module state. */
  load(freshKey: string): Promise<ControllerModule>;
}

export interface RunOptions {
  spec: RunSpec;
  stream: StreamCase;
  /** Injected in tests; defaults to the wall clock. */
  now?: () => string;
  log?: (message: string) => void;
}

function emptyResult(failure_code: string): EndResult {
  return {
    status: "infra_failed",
    score_minor: null,
    revenue_minor: 0,
    delivered_orders: 0,
    failure_code,
    final_action_results: [],
    final_wake_result: null,
  };
}

/**
 * Placeholder hash for a run the kernel never finished: there is no world to
 * hash, and the record still needs a syntactically valid sha256 field.
 */
function absentStateHash(run_id: string): string {
  return sha256Hex(`infra_failed|${run_id}`);
}

function bookValueOf(stream: StreamCase): { order_count: number; book_value_minor: number } {
  let book_value_minor = 0;
  for (const order of stream.orders) book_value_minor += order.value_minor;
  return { order_count: stream.orders.length, book_value_minor };
}

/** Runs one (submission x scenario) case end to end. Never throws. */
export async function runOne(opts: RunOptions): Promise<RunOutcome> {
  const { spec, stream, log = () => {}, now = () => new Date().toISOString() } = opts;
  const config = stream.scenario.config;
  const difficulty = stream.scenario.difficulty;
  const run_id = runIdFor(
    spec.submission.model_label,
    spec.submission.generation,
    difficulty,
    stream.tag,
  );
  const base = {
    run_id,
    benchmark_version: spec.benchmark_version,
    difficulty,
    scenario_id: config.scenario_id,
    scenario_hash: scenarioHashFor(config),
    submission: spec.submission,
    replay_kind: stream.tag === "scoring" ? ("scoring" as const) : ("practice" as const),
    policy_seed: policySeedFor(run_id),
    ...bookValueOf(stream),
  };
  const finish = (
    partial: Omit<RunOutcome, keyof typeof base | "finished_at_iso">,
  ): RunOutcome => ({
    ...base,
    ...partial,
    finished_at_iso: now(),
  });

  let controller: ControllerModule;
  try {
    controller = await spec.load(`${run_id}#${spec.submission.submission_id}`);
  } catch (error) {
    const message = `load failed: ${error instanceof Error ? error.message : String(error)}`;
    log(`!! INFRA FAILURE ${run_id}: ${message}`);
    return finish({
      result: emptyResult("HOST_LOAD_ERROR"),
      state_hash: absentStateHash(run_id),
      events: [],
      judge_ok: false,
      judge_mismatches: [message],
      wall: { decisions: 0, total_actions: 0, duration_ms: 0 },
      infra_alarm: message,
    });
  }

  let out: RunOutput;
  try {
    out = runScenario({
      config,
      orderStream: stream.orders,
      controller,
      policy_seed: base.policy_seed,
    });
  } catch (error) {
    const message = `kernel threw: ${error instanceof Error ? error.message : String(error)}`;
    log(`!! INFRA FAILURE ${run_id}: ${message}`);
    return finish({
      result: emptyResult("HOST_KERNEL_EXCEPTION"),
      state_hash: absentStateHash(run_id),
      events: [],
      judge_ok: false,
      judge_mismatches: [message],
      wall: { decisions: 0, total_actions: 0, duration_ms: 0 },
      infra_alarm: message,
    });
  }

  const verdict = verifyRun(config, stream.orders, out.events);
  if (!verdict.ok) {
    const message = `judge disagrees: ${verdict.mismatches.slice(0, 3).join(" | ")}`;
    log(`!! INFRA FAILURE ${run_id}: ${message}`);
    return finish({
      result: {
        ...out.result,
        status: "infra_failed",
        score_minor: null,
        failure_code: "JUDGE_MISMATCH",
      },
      state_hash: out.stateHash,
      events: out.events,
      judge_ok: false,
      judge_mismatches: verdict.mismatches,
      wall: {
        decisions: out.stats.decisions,
        total_actions: out.stats.totalActions,
        duration_ms: Math.round(out.stats.decisionWallMs),
      },
      infra_alarm: message,
    });
  }

  return finish({
    result: out.result,
    state_hash: out.stateHash,
    events: out.events,
    judge_ok: true,
    judge_mismatches: [],
    wall: {
      decisions: out.stats.decisions,
      total_actions: out.stats.totalActions,
      duration_ms: Math.round(out.stats.decisionWallMs),
    },
    infra_alarm: null,
  });
}

export interface MatrixOptions {
  benchmark_version: string;
  submissions: {
    meta: SubmissionMeta;
    load(freshKey: string): Promise<ControllerModule>;
  }[];
  streams: StreamCase[];
  log?: (message: string) => void;
}

/** The full case matrix: every submission against every stream. */
export async function runMatrix(opts: MatrixOptions): Promise<RunOutcome[]> {
  const log = opts.log ?? (() => {});
  const outcomes: RunOutcome[] = [];
  for (const submission of opts.submissions) {
    for (const stream of opts.streams) {
      const outcome = await runOne({
        spec: {
          benchmark_version: opts.benchmark_version,
          submission: submission.meta,
          load: submission.load,
        },
        stream,
        log,
      });
      log(
        `  ${outcome.run_id.padEnd(34)} ${String(outcome.result.score_minor ?? "null").padStart(7)}` +
          `  ${outcome.result.status.padEnd(16)} judge=${outcome.judge_ok ? "ok" : "FAIL"}`,
      );
      outcomes.push(outcome);
    }
  }
  return outcomes;
}