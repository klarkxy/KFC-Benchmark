import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { isControllerModule, type ControllerModule, type SubmissionMeta } from "@kitchensched/contracts";

import { SUBMISSIONS_DIR } from "./paths.js";

/**
 * Submission discovery and loading (submissions/README.md convention).
 *
 *   submissions/<model_label>/gen-<N>/submission.ts
 *   submissions/<model_label>/submission.ts      (generation defaults to 1)
 *
 * `model_label` may itself contain slashes ("baselines/greedy"), so the label
 * is every path segment below submissions/ except the trailing gen dir and
 * the file name.
 *
 * Every run imports a FRESH module instance (cache-busting query) so global
 * state of one run can never leak into the next one.
 */

export interface LoadedSubmission {
  submission_id: string;
  model_label: string;
  generation: number;
  source_path: string;
  relative_path: string;
  source_sha256: string;
  load(freshKey: string): Promise<ControllerModule>;
}

const GEN_DIR = /^gen-(\d+)$/;

/** Filesystem-safe, collision-free form of a model label ("a/b" -> "a-b"). */
export function slugifyLabel(label: string): string {
  const slug = label.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? "submission" : slug;
}

export function submissionIdFor(model_label: string, generation: number): string {
  return `sub-${slugifyLabel(model_label)}-${generation}`;
}

export function submissionMeta(loaded: LoadedSubmission): SubmissionMeta {
  return {
    submission_id: loaded.submission_id,
    source_sha256: loaded.source_sha256,
    model_label: loaded.model_label,
    generation: loaded.generation,
  };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every `submission.ts` under `dir`, ordered by label then generation. */
export function discoverSubmissions(dir: string = SUBMISSIONS_DIR): LoadedSubmission[] {
  const found: { label: string; generation: number; path: string }[] = [];

  const walk = (current: string, segments: string[]): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(path, [...segments, entry.name]);
        continue;
      }
      if (entry.name !== "submission.ts") continue;
      const last = segments.length > 0 ? (segments[segments.length - 1] ?? "") : "";
      const gen = GEN_DIR.exec(last);
      const label = gen === null ? segments.join("/") : segments.slice(0, -1).join("/");
      const generation = gen === null ? 1 : Number.parseInt(gen[1] ?? "1", 10);
      if (label === "") continue;
      found.push({ label, generation, path });
    }
  };

  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true) walk(dir, []);

  return found
    .sort((a, b) =>
      a.label < b.label ? -1 : a.label > b.label ? 1 : a.generation - b.generation,
    )
    .map((entry) => {
      const source_sha256 = sha256File(entry.path);
      return {
        submission_id: submissionIdFor(entry.label, entry.generation),
        model_label: entry.label,
        generation: entry.generation,
        source_path: entry.path,
        relative_path: relative(SUBMISSIONS_DIR, entry.path).split(sep).join("/"),
        source_sha256,
        load(freshKey: string): Promise<ControllerModule> {
          return loadController(entry.path, freshKey);
        },
      };
    });
}

/** Imports one submission as a fresh module instance and shape-checks it. */
export async function loadController(path: string, freshKey: string): Promise<ControllerModule> {
  const url = `${pathToFileURL(path).href}?run=${encodeURIComponent(freshKey)}`;
  const mod: unknown = await import(url);
  if (!isControllerModule(mod)) {
    throw new Error(`${path}: default export does not satisfy ControllerModule (init/decide)`);
  }
  // The guard resolves the default export for us; hand that same object on.
  const exported = (mod as { default?: unknown }).default;
  return (exported ?? mod) as ControllerModule;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Minimal glob for `--submissions`: `*` (no slash), `**` (any depth) and
 * `?` (one non-slash char), matched against the model label, e.g.
 * `baselines/*` or `**` plus a name.
 */
export function matchesGlob(label: string, glob: string): boolean {
  let pattern = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob.charAt(i);
    if (ch === "*" && glob.charAt(i + 1) === "*") {
      i += 2;
      if (glob.charAt(i) === "/") {
        i += 1;
        pattern += "(?:.*/)?";
      } else {
        pattern += ".*";
      }
      continue;
    }
    if (ch === "*") {
      pattern += "[^/]*";
    } else if (ch === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegExp(ch);
    }
    i += 1;
  }
  return new RegExp(`${pattern}$`).test(label);
}

export function filterSubmissions(
  loaded: readonly LoadedSubmission[],
  glob: string | undefined,
): LoadedSubmission[] {
  if (glob === undefined || glob === "") return [...loaded];
  return loaded.filter((entry) => matchesGlob(entry.model_label, glob));
}