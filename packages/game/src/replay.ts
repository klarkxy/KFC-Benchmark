import { PROTOCOL_VERSION, canonicalSerialize } from "@kitchensched/contracts";
import type {
  EventRecord,
  Hash,
  OrderStreamMeta,
  PublicConfig,
  ReplayFile,
  ReplayKind,
} from "@kitchensched/contracts";
import { sha256Hex } from "@kitchensched/core";

/**
 * Replay serialization, byte-compatible with the host runner
 * (packages/host/src/artifacts.ts `replayFileOf`): the Pages site's replay
 * reducer consumes exactly this shape, so a human game can be replayed, shared
 * and rendered with the same code path as a scored run.
 */

/** Mirrors `ENGINE_VERSION` in packages/host/src/runner.ts. */
export const GAME_ENGINE_VERSION = "core/0.3.0";

export interface ReplayMeta {
  /** Version label the site groups artifacts under. */
  benchmark_version: string;
  /** Public stream metadata; a human session always plays a public stream. */
  order_stream: OrderStreamMeta;
  /** Defaults to "human". */
  replay_kind?: ReplayKind;
  /** Defaults to sha256 of the canonical config, as `scenarioHashFor` computes it. */
  scenario_hash?: Hash;
  /** Defaults to GAME_ENGINE_VERSION. */
  engine_version?: string;
}

/** sha256 of the canonical public config; binds a replay to the exact kitchen. */
export function scenarioHashFor(config: PublicConfig): Hash {
  return sha256Hex(canonicalSerialize(config));
}

/** Builds the replay file for a finished (or in-progress) session. */
export function buildReplayFile(
  config: PublicConfig,
  meta: ReplayMeta,
  events: readonly EventRecord[],
): ReplayFile {
  return {
    header: {
      replay_schema_version: "1",
      engine_version: meta.engine_version ?? GAME_ENGINE_VERSION,
      protocol_version: PROTOCOL_VERSION,
      benchmark_version: meta.benchmark_version,
      scenario_id: config.scenario_id,
      scenario_hash: meta.scenario_hash ?? scenarioHashFor(config),
      clock_mode: "paused_code",
      replay_kind: meta.replay_kind ?? "human",
      order_stream: meta.order_stream,
    },
    events: [...events],
  };
}

/**
 * The exact bytes the host writes for a replay artifact: 2-space JSON with a
 * trailing newline, so a browser download matches `results/.../replays/*.json`.
 */
export function serializeReplayFile(file: ReplayFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
