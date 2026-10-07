/**
 * @kitchensched/core — deterministic simulation kernel and independent judge
 * for KitchenSched (protocol 0.3.0-web).
 *
 * Public surface:
 *   runScenario(opts)  -> one full run: EndResult, event stream, state hash
 *   verifyRun(config, orderStream, events) -> independent ledger re-check
 *
 * Semantics follow doc 02 (仿真引擎与裁判规则) and doc 03 (控制器协议与SDK).
 */

export { runScenario } from "./kernel.js";
export type { FailureCode, RunOptions, RunOutput, RunStats } from "./kernel.js";

export { verifyRun } from "./judge.js";
export type { VerifyResult } from "./judge.js";

export { computeStateHash, isHash, sha256Hex } from "./hash.js";
export type {
  HashDelivery,
  HashLot,
  HashOrder,
  HashState,
  HashStation,
  HashTask,
} from "./hash.js";

// Convenience re-exports so the host needs a single import.
export type {
  Action,
  ActionResult,
  ControllerModule,
  Decision,
  EndResult,
  EventRecord,
  Item,
  Lot,
  Observation,
  Order,
  PublicConfig,
  Recipe,
  RunStatus,
  StationDef,
  Task,
  WakeResult,
} from "@kitchensched/contracts";
export { PROTOCOL_VERSION } from "@kitchensched/contracts";
