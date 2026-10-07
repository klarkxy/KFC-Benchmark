/**
 * One JSON fetch for every static artifact the site reads (results/ and
 * scenarios/).
 */

/**
 * Hard ceiling for one artifact fetch. Cross-version run resolution probes
 * versions sequentially, so a single hung connection (observed in the wild:
 * TCP stalls on some networks instead of a clean 404) must abort and let the
 * probe move on instead of bricking the page in its loading state forever.
 */
const FETCH_TIMEOUT_MS = 10_000;

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    cache: "no-cache",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} — ${url}`);
  }
  return (await response.json()) as T;
}
