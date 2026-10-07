import type {
  LeaderboardFile,
  ReplayFile,
  ResultsIndex,
  RunRecord,
} from "@kitchensched/contracts";
import type { ReplayEvent } from "../replay/reducer";

/**
 * Wire shape as the site consumes it. The contract types `events` as
 * `EventRecord[]`, which cannot express the type/payload correlation; the
 * union is re-narrowed once here, at the fetch boundary.
 */
export type ReplayFileData = Omit<ReplayFile, "events"> & { events: ReplayEvent[] };

/**
 * Every artifact path in the contracts is relative to `results/`, which lives
 * at the deployed site root. Hash routing never changes the document path, so
 * resolving against document.baseURI works for `/`, `/<repo>/` and localhost.
 */
export const RESULTS_ROOT = new URL("results/", document.baseURI);

export function assetUrl(relativeToResults: string): string {
  return new URL(relativeToResults, RESULTS_ROOT).href;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} — ${url}`);
  }
  return (await response.json()) as T;
}

export function loadIndex(): Promise<ResultsIndex> {
  return fetchJson<ResultsIndex>(assetUrl("index.json"));
}

export type VersionEntry = ResultsIndex["versions"][number];

/** Newest entry by published_at_iso, falling back to array order. */
export function latestVersion(index: ResultsIndex): VersionEntry {
  const versions = [...index.versions].sort((a, b) =>
    a.published_at_iso < b.published_at_iso ? 1 : a.published_at_iso > b.published_at_iso ? -1 : 0,
  );
  const first = versions[0];
  if (!first) throw new Error("results/index.json 没有可用的 benchmark_version");
  return first;
}

export function loadLeaderboard(version: VersionEntry): Promise<LeaderboardFile> {
  return fetchJson<LeaderboardFile>(assetUrl(version.leaderboard));
}

export function loadRun(version: string, runId: string): Promise<RunRecord> {
  return fetchJson<RunRecord>(assetUrl(`${version}/runs/${runId}.json`));
}

/** Finds a run by id, trying the newest benchmark version first. */
export async function resolveRun(
  index: ResultsIndex,
  runId: string,
): Promise<{ version: string; run: RunRecord }> {
  const ordered = [latestVersion(index), ...index.versions];
  const seen = new Set<string>();
  let lastError: unknown;
  for (const entry of ordered) {
    if (seen.has(entry.benchmark_version)) continue;
    seen.add(entry.benchmark_version);
    try {
      const run = await loadRun(entry.benchmark_version, runId);
      return { version: entry.benchmark_version, run };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`未找到 run ${runId}`);
}

export function loadReplay(run: RunRecord): Promise<ReplayFileData> {
  if (!run.replay) throw new Error(`run ${run.run_id} 未发布回放`);
  return fetchJson<ReplayFileData>(assetUrl(run.replay));
}

export function replayUrl(run: RunRecord): string {
  if (!run.replay) throw new Error(`run ${run.run_id} 未发布回放`);
  return assetUrl(run.replay);
}
