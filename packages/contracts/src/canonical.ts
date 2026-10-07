/**
 * Canonical serialization for state hashing (doc 02 §11):
 * UTF-8 JSON, object keys sorted ASCII, no whitespace, integers decimal,
 * array order preserved. Only integers, booleans, null, ASCII ids and
 * structural fields participate — display names and wall-clock metrics
 * must be excluded by the caller before serialization.
 */
export function canonicalSerialize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
