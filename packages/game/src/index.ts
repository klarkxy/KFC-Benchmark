/**
 * @kitchensched/game — browser-playable human game on top of the real
 * KitchenSched kernel (protocol 0.3.0-web).
 *
 * Framework-free and free of Node built-ins: a session is the deterministic
 * kernel paused between human decisions, plus the pure helpers a UI needs to
 * build legal actions and to serialize a replay the Pages site can render.
 */

export { createGameSession } from "./session.js";
export type { GameSession, GameSessionOptions, SubmitResult } from "./session.js";

export {
  createActionIdFactory,
  fefoLots,
  planDeliverOutputs,
  planLots,
  planStartInputs,
  producedItemIds,
} from "./helpers.js";
export type { LotPlan } from "./helpers.js";

export { buildReplayFile, GAME_ENGINE_VERSION, scenarioHashFor, serializeReplayFile } from "./replay.js";
export type { ReplayMeta } from "./replay.js";

// Types the UI needs to type its own components and reducers.
export type { RunOutput } from "@kitchensched/core";
export type {
  Action,
  ActionResult,
  Decision,
  EventRecord,
  Lot,
  LotQty,
  Observation,
  Order,
  PublicConfig,
  Recipe,
  ReplayFile,
  Task,
  WakeResult,
} from "@kitchensched/contracts";
