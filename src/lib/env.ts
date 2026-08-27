/**
 * Parse a positive-milliseconds env override; garbage values (non-numeric,
 * zero, negative) fall back to the default instead of leaking NaN into
 * user-facing messages or disabling timeouts by accident.
 */
export function parseMsEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
