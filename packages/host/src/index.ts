/**
 * @kitchensched/host — benchmark host surface.
 *
 * The CLI (src/cli.ts) is the entry point; these exports exist so tests and
 * future tooling can reuse discovery, the runner and the artifact writers.
 */

export { REPO_ROOT, RESULTS_DIR, SCENARIOS_DIR, SUBMISSIONS_DIR } from "./paths.js";
export {
  discoverSubmissions,
  filterSubmissions,
  loadController,
  matchesGlob,
  slugifyLabel,
  submissionIdFor,
  submissionMeta,
  type LoadedSubmission,
} from "./loader.js";
export {
  GENERATOR_VERSION,
  loadScenarios,
  practiceStreams,
  sealedStreams,
  type ScenarioCase,
  type StreamCase,
} from "./scenarios.js";
export {
  ENGINE_VERSION,
  policySeedFor,
  runIdFor,
  runMatrix,
  runOne,
  scenarioHashFor,
  type MatrixOptions,
  type RunOutcome,
  type RunSpec,
} from "./runner.js";
export {
  buildLeaderboardFile,
  mergeIndex,
  replayFileOf,
  replayRelativePath,
  runRecordOf,
  writeResults,
  type WriteResultsOptions,
  type WriteResultsOutput,
} from "./artifacts.js";