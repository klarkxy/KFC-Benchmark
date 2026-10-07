import { useSyncExternalStore } from "react";

export type Route =
  | { name: "leaderboard" }
  | { name: "replay"; runId: string }
  | { name: "methodology" };

export const DEFAULT_HASH = "#/";

/** `#/replay/<runId>` -> { name: "replay", runId }; unknown hashes fall back home. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+/, "");
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const head = segments[0];
  if (head === "methodology") return { name: "methodology" };
  if (head === "replay" && segments[1]) {
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
