import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Difficulty, Order, PublicConfig } from "@kitchensched/contracts";
import {
  GENERATOR_VERSION,
  generateOrderStream,
  getCalibration,
  materializeOrders,
  type OrderStreamFile,
} from "@kitchensched/scen";

import { SCENARIOS_DIR } from "./paths.js";

/**
 * Scenario discovery: one case per `scenarios/<tier>/kitchen.json`.
 *
 * The kitchen bytes are the frozen public config handed to candidates; the
 * order stream is the judge-owned trajectory. In practice mode the stream
 * ships with the repo (public). In sealed mode it is regenerated in memory
 * from a CI secret and never touches the disk.
 */

export interface ScenarioCase {
  config: PublicConfig;
  difficulty: Difficulty;
  /** Directory name under scenarios/, e.g. "medium". */
  tier: string;
  kitchen_path: string;
}

export interface StreamCase {
  scenario: ScenarioCase;
  /** Never serialized in sealed mode; holds no seed when visibility is sealed. */
  stream: OrderStreamFile;
  orders: Order[];
  visibility: "public" | "sealed";
  /** Only set for public streams; sealed seeds stay in memory and unrecorded. */
  seed: number | undefined;
  generator_version: string;
  /** Suffix of the run id, e.g. "practice" / "scoring". */
  tag: string;
}

const DIFFICULTY_RANK: Record<string, number> = { easy: 0, medium: 1, complex: 2 };

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function difficultyRank(difficulty: string): number {
  return DIFFICULTY_RANK[difficulty] ?? 99;
}

/** Reads every kitchen under `dir`, ordered easy -> medium -> complex. */
export function loadScenarios(dir: string = SCENARIOS_DIR): ScenarioCase[] {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const cases: ScenarioCase[] = [];
  for (const tier of entries) {
    const kitchen_path = join(dir, tier, "kitchen.json");
    const config = readJsonFile<PublicConfig>(kitchen_path);
    if (config.protocol_version !== "0.3.0-web") {
      throw new Error(`${kitchen_path}: unsupported protocol_version ${config.protocol_version}`);
    }
    cases.push({ config, difficulty: config.difficulty, tier, kitchen_path });
  }
  cases.sort(
    (a, b) => difficultyRank(a.difficulty) - difficultyRank(b.difficulty) || (a.config.scenario_id < b.config.scenario_id ? -1 : 1),
  );
  return cases;
}

function makeStreamCase(
  scenario: ScenarioCase,
  stream: OrderStreamFile,
  visibility: "public" | "sealed",
  tag: string,
): StreamCase {
  return {
    scenario,
    stream,
    orders: materializeOrders(scenario.config, stream),
    visibility,
    seed: visibility === "public" ? stream.seed : undefined,
    generator_version: stream.generator_version,
    tag,
  };
}

/** Public practice streams committed next to each kitchen. */
export function practiceStreams(scenarios: readonly ScenarioCase[], dir: string = SCENARIOS_DIR): StreamCase[] {
  return scenarios.map((scenario) => {
    const path = join(dir, scenario.tier, "practice-stream.json");
    const stream = readJsonFile<OrderStreamFile>(path);
    if (stream.scenario_id !== scenario.config.scenario_id) {
      throw new Error(`${path}: scenario_id ${stream.scenario_id} does not match the kitchen`);
    }
    return makeStreamCase(scenario, stream, "public", "practice");
  });
}

/**
 * Sealed scoring streams: same generator, same arrival cadence and demand
 * weights as the practice stream, different secret seed. The stream object
 * stays in memory; nothing derived from the seed is written to disk.
 */
export function sealedStreams(scenarios: readonly ScenarioCase[], seed: number): StreamCase[] {
  return scenarios.map((scenario) => {
    const calibration = getCalibration(scenario.config.scenario_id);
    if (calibration === undefined) {
      throw new Error(
        `no calibration for scenario ${scenario.config.scenario_id}; cannot generate a sealed stream`,
      );
    }
    const stream = generateOrderStream(
      scenario.config,
      seed,
      {
        interval_ms: calibration.arrivals.interval_ms,
        start_at_ms: calibration.arrivals.start_at_ms,
        end_at_ms: calibration.end_at_ms,
      },
      calibration.demand,
    );
    return makeStreamCase(scenario, stream, "sealed", "scoring");
  });
}

export { GENERATOR_VERSION };