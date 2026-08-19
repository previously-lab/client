import { readFileSync } from 'node:fs';

/**
 * Version policy (design doc §10.2): the client embeds one supported kernel
 * minor line (package.json `previously.kernelLine`, e.g. "0.8"). A kernel is
 * compatible iff its major.minor equals the line; the patch level is free.
 * Crossing a minor line requires a client upgrade — we refuse honestly rather
 * than running a kernel we do not understand.
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

/** The `major.minor` line of a version, e.g. "0.8". */
export function versionLine(v: Semver): string {
  return `${v.major}.${v.minor}`;
}

export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * The kernel line this client supports, read from package.json
 * (`previously.kernelLine`). Both src/ and dist/ layouts resolve to the repo
 * root package.json with `../../`.
 */
export function getKernelLine(): string {
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { previously?: { kernelLine?: string } };
  const line = pkg.previously?.kernelLine;
  if (!line || !/^\d+\.\d+$/.test(line)) {
    throw new Error(`package.json is missing a valid "previously.kernelLine" (got: ${line})`);
  }
  return line;
}

export interface CompatResult {
  ok: boolean;
  /** Present when ok === false: the honest, user-actionable error message. */
  message?: string;
}

/** Check a kernel version against the client's kernel line. */
export function checkCompat(kernelVersion: string, line: string = getKernelLine()): CompatResult {
  const v = parseSemver(kernelVersion);
  if (!v) {
    return { ok: false, message: `Unparseable kernel version: "${kernelVersion}" (expected x.y.z)` };
  }
  const kernelMinor = versionLine(v);
  if (kernelMinor === line) return { ok: true };
  return {
    ok: false,
    message:
      `Kernel ${formatSemver(v)} is on line ${kernelMinor}.x, but this client supports ` +
      `line ${line}.x. Kernel ${kernelMinor}.x requires client >= ${kernelMinor} — ` +
      `run \`npm i -g previously-client@latest\` and try again.`,
  };
}

/**
 * Extract the kernel version from the agent repo's
 * `src/lib/version/constants.ts`. The file exports the version as a plain
 * string constant (e.g. `export const PREVIOUSLY_VERSION = '0.8.0';`); we
 * parse the first x.y.z literal robustly rather than depending on the exact
 * constant name. package.json in the agent repo is stale and must NOT be used.
 */
export function parseKernelVersionFromSource(source: string): string | null {
  const m = /['"]v?(\d+\.\d+\.\d+)['"]/.exec(source);
  return m?.[1] ?? null;
}

export interface RemoteTag {
  /** Tag name as published, e.g. "v0.8.2" or "0.8.2" — usable as a git ref. */
  tag: string;
  version: Semver;
}

/**
 * Parse `git ls-remote --tags` output into candidate kernel releases.
 * Skips peeled `^{}` lines (annotated tags appear twice; the peeled line
 * carries the same tag name) and any tag that is not a strict semver.
 */
export function parseRemoteTags(lsRemoteOutput: string): RemoteTag[] {
  const byVersion = new Map<string, RemoteTag>();
  for (const line of lsRemoteOutput.split(/\r?\n/)) {
    const m = /^[0-9a-f]+\trefs\/tags\/(v?\d+\.\d+\.\d+)$/.exec(line.trim());
    if (!m) continue;
    const version = parseSemver(m[1]!);
    if (version && !byVersion.has(formatSemver(version))) {
      byVersion.set(formatSemver(version), { tag: m[1]!, version });
    }
  }
  return [...byVersion.values()];
}

export type UpgradeTarget =
  | { kind: 'install'; release: RemoteTag }
  | { kind: 'up-to-date'; version: Semver }
  | { kind: 'crossed-line'; latest: Semver; message: string }
  | { kind: 'no-tags' };

/**
 * Decide what `previously upgrade` should do, given the repo's tags.
 * - Newest tag overall has crossed to a new minor → refuse (upgrade client first).
 * - Otherwise install the newest tag inside our line, unless already current.
 */
export function selectUpgradeTarget(
  tags: RemoteTag[],
  line: string,
  currentVersion: string | null,
): UpgradeTarget {
  if (tags.length === 0) return { kind: 'no-tags' };
  const latest = [...tags].sort((a, b) => compareSemver(a.version, b.version))[tags.length - 1]!;
  const latestLine = versionLine(latest.version);
  if (latestLine !== line) {
    return {
      kind: 'crossed-line',
      latest: latest.version,
      message:
        `The newest kernel release is ${formatSemver(latest.version)} (line ${latestLine}.x), ` +
        `but this client supports line ${line}.x. Kernel ${latestLine}.x requires ` +
        `client >= ${latestLine} — run \`npm i -g previously-client@latest\` first.`,
    };
  }
  const current = currentVersion !== null ? parseSemver(currentVersion) : null;
  if (current && versionLine(current) === line && compareSemver(latest.version, current) <= 0) {
    return { kind: 'up-to-date', version: latest.version };
  }
  return { kind: 'install', release: latest };
}
