/**
 * Read a whole-number page option from URL search parameters. A missing or blank value, or one
 * that is not a finite number, gives the fallback; any other value is rounded and kept in range.
 */
export function readWholeNumberOption(query, name, fallback, minimum, maximum) {
  const raw = query.get(name);
  const value = raw === null || raw.trim() === '' ? fallback : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.round(Math.max(minimum, Math.min(maximum, value)));
}
