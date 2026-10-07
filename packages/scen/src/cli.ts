#!/usr/bin/env node
/**
 * Scenario generator entry point — `pnpm gen:scenarios`.
 *
 * Writes scenarios/<difficulty>/kitchen.json and practice-stream.json for
 * every kitchen in KITCHENS, validates each file before it is written, and
 * prints a calibration summary to stdout.
 */

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PublicConfig } from "@kitchensched/contracts";

import { GENERATOR_VERSION, generateOrderStream, streamStats, type OrderStreamFile } from "./stream.js";
import { KITCHENS, type KitchenDefinition } from "./kitchens.js";
import { formatIssues, validatePublicConfig, validateOrderStream } from "./validate.js";

/** Seed for the public practice stream; hidden eval streams get their own. */
export const PRACTICE_SEED = 20_261_007;

export interface WrittenScenario {
  scenario_id: string;
  difficulty: string;
  directory: string;
  kitchen_path: string;
  stream_path: string;
  config: PublicConfig;
  stream: OrderStreamFile;
}

const here = dirname(fileURLToPath(import.meta.url));
/** packages/scen/src -> repository root. */
const REPO_ROOT = join(here, "..", "..", "..");
export const SCENARIOS_DIR = join(REPO_ROOT, "scenarios");

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function formatCredit(minor: number): string {
  return (minor / 100).toFixed(2);
}

/** Generates and validates one kitchen + its practice stream, writing both. */
export function generateScenario(
  kitchen: KitchenDefinition,
  rootDir: string = SCENARIOS_DIR,
  seed: number = PRACTICE_SEED,
): WrittenScenario {
  const { calibration, config } = kitchen;
  const stream = generateOrderStream(
    config,
    seed,
    {
      interval_ms: calibration.arrivals.interval_ms,
      start_at_ms: calibration.arrivals.start_at_ms,
      end_at_ms: calibration.end_at_ms,
    },
    calibration.demand,
  );

  const configIssues = validatePublicConfig(config);
  if (configIssues.length > 0) {
    throw new Error(`${calibration.scenario_id}: kitchen.json failed validation:\n${formatIssues(configIssues)}`);
  }
  const streamIssues = validateOrderStream(config, stream);
  if (streamIssues.length > 0) {
    throw new Error(
      `${calibration.scenario_id}: practice-stream.json failed validation:\n${formatIssues(streamIssues)}`,
    );
  }

  const directory = join(rootDir, calibration.difficulty);
  const kitchenPath = join(directory, "kitchen.json");
  const streamPath = join(directory, "practice-stream.json");
  mkdirSync(directory, { recursive: true });
  writeJson(kitchenPath, config);
  writeJson(streamPath, stream);

  return {
    scenario_id: calibration.scenario_id,
    difficulty: calibration.difficulty,
    directory,
    kitchen_path: kitchenPath,
    stream_path: streamPath,
    config,
    stream,
  };
}

function printSummary(written: readonly WrittenScenario[]): void {
  const lines: string[] = [];
  lines.push(`kitchensched scenarios — generator ${GENERATOR_VERSION}`);
  lines.push("");

  for (const entry of written) {
    const { config, stream } = entry;
    const orderable = config.items.filter((i) => i.orderable);
    const raw = config.items.filter((i) => i.supply === "unlimited_raw");
    const produced = config.items.filter((i) => i.supply === "produced" && !i.orderable);
    const stats = streamStats(config, stream);

    lines.push(`[${entry.difficulty}] ${entry.scenario_id}  (protocol ${config.protocol_version}, scenario_version ${config.scenario_version})`);
    lines.push(`  kitchen     ${relative(entry.kitchen_path)}`);
    lines.push(`  stream      ${relative(entry.stream_path)}  seed=${stream.seed}`);
    lines.push(`  clock       end_at_ms=${config.end_at_ms}  arrivals ${stats.first_at_ms}..${stats.last_at_ms} ms`);
    lines.push(
      `  scale       ${orderable.length} orderable products / ${config.recipes.length} recipes / ${config.stations.length} stations` +
        `  (${raw.length} raw, ${produced.length} intermediate items)`,
    );
    lines.push(`  demand      ${stats.order_count} orders, ${stats.total_units} units, value ${formatCredit(stats.total_value_minor)} credits`);
    lines.push("  products");
    for (const item of orderable) {
      const demand = stats.per_item.get(item.id);
      const units = demand?.units ?? 0;
      const share = stats.total_units > 0 ? (units / stats.total_units) * 100 : 0;
      lines.push(
        `    ${item.id.padEnd(18)} ${formatCredit(item.price_minor).padStart(7)}  demand ${String(units).padStart(4)} units (${share.toFixed(1).padStart(5)}%)`,
      );
    }
    lines.push("");
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

function relative(path: string): string {
  return path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length + 1) : path;
}

function main(): void {
  const written = KITCHENS.map((kitchen) => generateScenario(kitchen));
  printSummary(written);
}

/** True only when this module is the process entry point (ts-safe). */
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main();
}
