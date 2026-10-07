import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repository layout anchors. `packages/host/src/paths.ts` -> repo root.
 * Everything the host reads (scenarios, submissions) and writes (results)
 * hangs off this root, so the CLI behaves the same from any cwd.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const SCENARIOS_DIR = join(REPO_ROOT, "scenarios");
export const SUBMISSIONS_DIR = join(REPO_ROOT, "submissions");
export const RESULTS_DIR = join(REPO_ROOT, "results");