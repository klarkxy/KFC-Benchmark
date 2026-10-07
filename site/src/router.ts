import { useSyncExternalStore } from "react";

export type Route =
  | { name: "leaderboard" }
  | { name: "replay"; runId: string; version?: string }
  | { name: "methodology" };

export const DEFAULT_HASH = "#/";

/**
 * `#/replay/<version>/<runId>` -> version-qualified replay (preferred: the
 * leaderboard knows the version, so no cross-version probing is needed).
 * `#/replay/<runId>` -> legacy bare form, resolved by probing versions.
 * Unknown hashes fall back home.
 */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+/, "");
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const head = segments[0];
  if (head === "methodology") return { name: "methodology" };
  if (head === "replay" && segments[1]) {
    if (segments[2]) {
      return {
        name: "replay",
        version: decodeURIComponent(segments[1]),
        runId: decodeURIComponent(segments[2]),
      };
    }
    return { name: "replay", runId: decodeURIComponent(segments[1]) };
  }
  return { name: "leaderboard" };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "",
  );
  return parseRoute(hash);
}

export function href(path: string): string {
  return path.startsWith("#") ? path : `#${path}`;
}
