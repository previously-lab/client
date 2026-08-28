import { readFileSync } from 'node:fs';

/**
 * Version policy (design doc §10.2): the client is pinned to ONE exact kernel
 * version (package.json `previously.kernelVersion`, e.g. "0.9.0"). A kernel is
 * compatible iff its version equals the pin exactly — no minor lines, no patch
 * drift. Upgrading means upgrading the client package itself; there is no
 * in-place kernel upgrade machinery.
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** Parse a strict `x.y.z` version (optionally `v`-prefixed). Null on anything else. */
export function parseSemver(raw: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function formatSemver(v: Semver): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * The exact kernel version this client is pinned to, read from package.json
 * (`previously.kernelVersion`). Both src/ and dist/ layouts resolve to the
 * repo root package.json with `../../`.
 */
export function getPinnedKernelVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { previously?: { kernelVersion?: string } };
  const pinned = pkg.previously?.kernelVersion;
  if (!pinned || parseSemver(pinned) === null) {
    throw new Error(`package.json is missing a valid "previously.kernelVersion" (got: ${pinned})`);
  }
  return formatSemver(parseSemver(pinned)!);
}

export interface CompatResult {
  ok: boolean;
  /** Present when ok === false: the honest, user-actionable error message. */
  message?: string;
}

/** Check a kernel version against the client's pinned kernel version (exact equality). */
export function checkCompat(
  kernelVersion: string,
  pinned: string = getPinnedKernelVersion(),
): CompatResult {
  const v = parseSemver(kernelVersion);
  if (!v) {
    return { ok: false, message: `Unparseable kernel version: "${kernelVersion}" (expected x.y.z)` };
  }
  if (formatSemver(v) === pinned) return { ok: true };
  return {
    ok: false,
    message:
      `Kernel ${formatSemver(v)} does not match the version this client is pinned to ` +
      `(${pinned}). Client and kernel ship in lockstep: upgrade the client package ` +
      `(\`npm i -g @previously-lab/client@latest\`) to match your kernel, or reinstall the ` +
      `pinned kernel with \`previously kernel install\`.`,
  };
}

/**
 * Extract the kernel version from the agent repo's
 * `src/lib/version/constants.ts`. The file exports the version as a plain
 * string constant (e.g. `export const PREVIOUSLY_VERSION = '0.9.0';`); we
 * parse the first x.y.z literal robustly rather than depending on the exact
 * constant name. package.json in the agent repo is stale and must NOT be used.
 */
export function parseKernelVersionFromSource(source: string): string | null {
  const m = /['"]v?(\d+\.\d+\.\d+)['"]/.exec(source);
  return m?.[1] ?? null;
}
