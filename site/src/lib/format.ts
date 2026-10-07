/** Display helpers. Scores are integer `credit_minor` (1/100 credit). */
export const CURRENCY_UNIT = "credit_minor";
export const CURRENCY_SCALE = 100;

export function formatMinor(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return "—";
  return (minor / CURRENCY_SCALE).toFixed(2);
}

/** Compact hash for tables: sha256 -> first 10 lowercase hex chars. */
export function shortHash(hash: string | null | undefined, length = 10): string {
  if (!hash) return "—";
  return hash.slice(0, length);
}

/** Sim clock milliseconds -> mm:ss.d */
export function formatSimMs(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const tenths = Math.floor((safe % 1000) / 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

export function formatQtyLines(
  lines: readonly { item_id: string; quantity: number }[],
): string {
  return lines.map((line) => `${line.item_id}×${line.quantity}`).join(" + ");
}

export function formatPercent(part: number, total: number): string {
  if (total <= 0) return "—";
  return `${Math.round((part / total) * 100)}%`;
}
