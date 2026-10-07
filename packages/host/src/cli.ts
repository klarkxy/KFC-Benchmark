#!/usr/bin/env node
/**
 * KitchenSched host CLI.
 *
 *   score --benchmark <ver> [--submissions <glob>] [--replays]
 *   score --sealed --seed <n> [--benchmark <ver>]     # CI scoring path
 *
 * Practice mode replays the public streams committed under scenarios/ and
 * publishes replay files. Sealed mode regenerates the scored stream in memory
 * from a secret seed, records `visibility: "sealed"`, publishes no replay at
 * all, and never lets the seed reach the candidate API surface.
 */

import { join } from "node:path";

import {
  discoverSubmissions,
  filterSubmissions,
  submissionMeta,
  type LoadedSubmission,
} from "./loader.js";
import { loadScenarios, practiceStreams, sealedStreams, type StreamCase } from "./scenarios.js";
import { runMatrix, type RunOutcome } from "./runner.js";
import { writeResults } from "./artifacts.js";
import { RESULTS_DIR } from "./paths.js";

const DEFAULT_BENCHMARK = "p1-dev";
const USAGE = `kitchensched host

usage:
  score --benchmark <version> [--submissions <glob>] [--replays]
  score --sealed --seed <n> [--benchmark <version>]

options:
  --benchmark <version>   benchmark version id for results/<version>/ (default ${DEFAULT_BENCHMARK})
  --submissions <glob>    only run matching model labels, e.g. "baselines/*" (default all)
  --replays               publish replay files (practice mode only; default on for practice,
                          always off for sealed runs so the scored stream never ships)
  --sealed                scoring mode: in-memory streams from the seed, no replay files
  --seed <n>              scoring stream seed (defaults to $SCORING_SEED)
  -h, --help              this text
`;

interface Options {
  command: string;
  benchmark: string;
  submissions: string | undefined;
  sealed: boolean;
  replays: boolean;
  seed: number | undefined;
}

function parseArgs(argv: readonly string[]): Options | "help" {
  const options: Options = {
    command: "",
    benchmark: DEFAULT_BENCHMARK,
    submissions: undefined,
    sealed: false,
    replays: false,
    seed: undefined,
  };
  const next = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    switch (arg) {
      case "-h":
      case "--help":
        return "help";
      case "--sealed":
        options.sealed = true;
        break;
      case "--replays":
        options.replays = true;
        break;
      case "--benchmark":
        options.benchmark = next("--benchmark", i);
        i += 1;
        break;
      case "--submissions":
        options.submissions = next("--submissions", i);
        i += 1;
        break;
      case "--seed": {
        const raw = next("--seed", i);
        i += 1;
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
          throw new Error(`--seed must be an integer in [0, 4294967295], got "${raw}"`);
        }
        options.seed = parsed;
        break;
      }
      case "--":
        // pnpm/npm argument separator may survive script chaining; ignore it.
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        options.command = arg;
        break;
    }
  }
  return options;
}

function credits(minor: number | null): string {
  return minor === null ? "-" : (minor / 100).toFixed(2);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

function readSeed(options: Options): number {
  if (options.seed !== undefined) return options.seed;
  const fromEnv = process.env["SCORING_SEED"];
  // Drop it before any candidate module is imported: the secret must not
  // linger in a process the submissions run inside.
  delete process.env["SCORING_SEED"];
  if (fromEnv === undefined || fromEnv.trim() === "") {
    throw new Error("--sealed needs --seed <n> (or $SCORING_SEED)");
  }
  const parsed = Number.parseInt(fromEnv, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new Error("$SCORING_SEED must be an integer in [0, 4294967295]");
  }
  return parsed;
}

function printRuns(runs: readonly RunOutcome[]): void {
  const header = `${pad("run", 34)}${padStart("score_minor", 13)}${padStart("credits", 10)}  ${pad("status", 17)}${pad("judge", 7)}`;
  const lines = [header, "-".repeat(header.length)];
  for (const run of runs) {
    lines.push(
      pad(run.run_id, 34) +
        padStart(String(run.result.score_minor ?? "null"), 13) +
        padStart(credits(run.result.score_minor), 10) +
        `  ${pad(run.result.status, 17)}${pad(run.judge_ok ? "ok" : "FAIL", 7)}` +
        (run.infra_alarm === null ? "" : `  ${run.infra_alarm}`),
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printLeaderboard(runs: readonly RunOutcome[]): void {
  const rows = new Map<string, { label: string; difficulty: string; total: number; cases: number; book: number; infra: number }>();
  for (const run of runs) {
    const key = `${run.submission.model_label}|${run.difficulty}`;
    const row = rows.get(key) ?? {
      label: run.submission.model_label,
      difficulty: run.difficulty,
      total: 0,
      cases: 0,
      book: 0,
      infra: 0,
    };
    row.total += run.result.score_minor ?? 0;
    row.cases += 1;
    row.book = run.book_value_minor;
    if (run.result.status === "infra_failed") row.infra += 1;
    rows.set(key, row);
  }
  const lines: string[] = [];
  const header = `${pad("submission", 22)}${pad("difficulty", 11)}${padStart("mean_minor", 12)}${padStart("mean_cr", 10)}${padStart("book_cr", 10)}${padStart("share", 8)}`;
  lines.push(header, "-".repeat(header.length));
  for (const row of [...rows.values()].sort((a, b) =>
    a.label < b.label ? -1 : a.label > b.label ? 1 : a.difficulty < b.difficulty ? -1 : 1,
  )) {
    const mean = row.infra > 0 ? null : Math.round(row.total / row.cases);
    const share = mean === null || row.book === 0 ? "-" : `${((mean / row.book) * 100).toFixed(1)}%`;
    lines.push(
      pad(row.label, 22) +
        pad(row.difficulty, 11) +
        padStart(mean === null ? "null" : String(mean), 12) +
        padStart(credits(mean), 10) +
        padStart(credits(row.book), 10) +
        padStart(share, 8),
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function score(options: Options): Promise<number> {
  const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };
  const alarm = (message: string): void => {
    process.stderr.write(`${message}\n`);
  };

  const scenarios = loadScenarios();
  const streams = options.sealed ? sealedStreams(scenarios, readSeed(options)) : practiceStreams(scenarios);
  const submissions: LoadedSubmission[] = filterSubmissions(discoverSubmissions(), options.submissions);

  if (submissions.length === 0) {
    throw new Error("no submissions found (expected submissions/<label>/gen-<N>/submission.ts)");
  }

  const mode = options.sealed ? `sealed (${streams.length} streams, not published)` : "practice";
  log(
    `kitchensched score - benchmark ${options.benchmark} - ${mode} - ` +
      `${submissions.length} submission(s) x ${streams.length} scenario(s)`,
  );
  for (const stream of streams) {
    log(
      `  scenario ${stream.scenario.config.scenario_id} (${stream.scenario.difficulty}) ` +
        `${stream.orders.length} orders, book ${credits(stream.orders.reduce((sum, o) => sum + o.value_minor, 0))} cr`,
    );
  }

  const runs = await runMatrix({
    benchmark_version: options.benchmark,
    submissions: submissions.map((entry) => ({ meta: submissionMeta(entry), load: entry.load })),
    streams,
    log,
  });

  const publish_replays = !options.sealed;
  const meta = new Map<string, { visibility: "public" | "sealed"; seed?: number; generator_version: string }>();
  for (const stream of streams) {
    for (const run of runs) {
      if (run.scenario_id !== stream.scenario.config.scenario_id) continue;
      meta.set(run.run_id, {
        visibility: stream.visibility,
        generator_version: stream.generator_version,
        ...(stream.seed === undefined ? {} : { seed: stream.seed }),
      });
    }
  }

  const written = writeResults({
    benchmark_version: options.benchmark,
    runs,
    publish_replays,
    stream_meta: meta,
  });

  log("");
  log("runs");
  printRuns(runs);
  log("");
  log("leaderboard");
  printLeaderboard(runs);
  log("");
  log(
    `wrote ${written.records.length} run record(s)` +
      `${publish_replays ? ` + ${written.records.filter((r) => r.replay !== null).length} replay(s)` : " (no replays: sealed)"}` +
      ` to ${join(RESULTS_DIR, options.benchmark)}`,
  );

  const infra = runs.filter((run) => run.infra_alarm !== null);
  if (infra.length > 0) {
    alarm(`INFRA FAILURE: ${infra.length} run(s) could not be trusted; leaderboard means are null for those rows.`);
    return 1;
  }
  return 0;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help" || parsed.command === "") {
    process.stdout.write(USAGE);
    return parsed === "help" ? 0 : 2;
  }
  if (parsed.command !== "score") {
    process.stderr.write(`unknown command "${parsed.command}"\n\n${USAGE}`);
    return 2;
  }
  if (parsed.sealed && parsed.replays) {
    throw new Error("--replays cannot be combined with --sealed: scored runs never publish a replay");
  }
  return score(parsed);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });