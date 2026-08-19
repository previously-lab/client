import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { resolvePaths, type PreviouslyPaths } from './paths.js';
import {
  checkCompat,
  formatSemver,
  parseKernelVersionFromSource,
  parseSemver,
} from './version-policy.js';

/**
 * Kernel supply chain (design doc §10.1/§10.2).
 *
 * The kernel artifact is the Next.js standalone build of the agent repo,
 * built from a given git ref and installed into versioned directories:
 *
 *   <home>/kernel/versions/<version>/   standalone artifact (server.js, …)
 *   <home>/kernel/current.json          pointer: { version, dir, previous? }
 *
 * A JSON pointer file is used instead of a symlink because symlinks on
 * Windows require privileges we cannot assume. Installs are atomic: the new
 * version is fully staged in a temp dir and renamed into place BEFORE the
 * pointer flips, so a failed install leaves the running setup untouched and
 * `previously kernel rollback` can always flip back.
 *
 * External tool requirements (shell-outs via node:child_process, no npm
 * runtime deps): `git` for clone/ls-remote, `pnpm` for the repo build.
 */

/** Default agent repo the kernel is built from. */
export const DEFAULT_KERNEL_REPO = 'https://github.com/previously-lab/agent.git';

/** Marker file written into every installed version dir (machine-readable version, §10.2). */
export const KERNEL_MARKER = 'previously-kernel.json';

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Shell-out seam: tests inject a fake; production uses spawnSync. */
export type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string }) => ExecResult;

export const defaultExec: ExecFn = (cmd, args, opts) => {
  const res = spawnSync(cmd, args, { cwd: opts?.cwd, encoding: 'utf8' });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error,
  };
};

function runOrThrow(exec: ExecFn, cmd: string, args: string[], cwd?: string): void {
  const res = exec(cmd, args, cwd ? { cwd } : undefined);
  if (res.error) {
    throw new Error(
      `Failed to run \`${cmd}\`: ${res.error.message}. ` +
        `The kernel supply chain requires git and pnpm on PATH.`,
    );
  }
  if (res.status !== 0) {
    throw new Error(`\`${cmd} ${args.join(' ')}\` failed (exit ${res.status}):\n${res.stderr.trim()}`);
  }
}

export interface KernelPointer {
  version: string;
  dir: string;
  previous?: { version: string; dir: string };
}

/** Null when no kernel has ever been installed; throws on a corrupt pointer file. */
export function readCurrentPointer(paths: PreviouslyPaths = resolvePaths()): KernelPointer | null {
  if (!existsSync(paths.kernelCurrentPath)) return null;
  const raw = JSON.parse(readFileSync(paths.kernelCurrentPath, 'utf8')) as Partial<KernelPointer>;
  if (typeof raw.version !== 'string' || typeof raw.dir !== 'string') {
    throw new Error(`Corrupt kernel pointer at ${paths.kernelCurrentPath} (expected { version, dir })`);
  }
  return raw as KernelPointer;
}

function writeCurrentPointer(pointer: KernelPointer, paths: PreviouslyPaths): void {
  mkdirSync(paths.kernelDir, { recursive: true });
  writeFileSync(paths.kernelCurrentPath, JSON.stringify(pointer, null, 2) + '\n', 'utf8');
}

/** Versions currently installed under kernel/versions/ (temp staging dirs excluded). */
export function listInstalledVersions(paths: PreviouslyPaths = resolvePaths()): string[] {
  if (!existsSync(paths.kernelVersionsDir)) return [];
  return readdirSync(paths.kernelVersionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/** Read the machine-readable version marker from an installed kernel dir. */
export function readKernelVersionFromDir(dir: string): string | null {
  const markerPath = join(dir, KERNEL_MARKER);
  if (!existsSync(markerPath)) return null;
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { version?: unknown };
    return typeof marker.version === 'string' ? marker.version : null;
  } catch {
    return null;
  }
}

export interface InstallResult {
  pointer: KernelPointer;
  /** True when this install flipped the pointer to a new version. */
  switched: boolean;
}

/**
 * Stage a standalone artifact into versions/<version>/ atomically and flip
 * the pointer. Shared by both install sources. Throws (leaving the old
 * pointer and version dirs intact) on any failure.
 */
function stageAndSwitch(
  artifactDir: string,
  version: string,
  paths: PreviouslyPaths,
): InstallResult {
  const targetDir = join(paths.kernelVersionsDir, version);
  if (existsSync(targetDir)) {
    throw new Error(
      `Kernel ${version} is already installed at ${targetDir}. ` +
        `Use \`previously kernel rollback\` to switch back to it, or remove that directory to reinstall.`,
    );
  }
  if (!existsSync(join(artifactDir, 'server.js'))) {
    throw new Error(
      `Not a kernel standalone artifact: ${artifactDir} (missing server.js). ` +
        `Expected the contents of the agent repo's .next/standalone/ directory.`,
    );
  }

  mkdirSync(paths.kernelVersionsDir, { recursive: true });
  const stagingDir = join(paths.kernelVersionsDir, `.staging-${version}-${process.pid}`);
  rmSync(stagingDir, { recursive: true, force: true });
  try {
    cpSync(artifactDir, stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, KERNEL_MARKER), JSON.stringify({ version }, null, 2) + '\n', 'utf8');
    // Same-directory rename is atomic on both POSIX and Windows.
    renameSync(stagingDir, targetDir);
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }

  const prior = readCurrentPointer(paths);
  const pointer: KernelPointer = {
    version,
    dir: targetDir,
    ...(prior ? { previous: { version: prior.version, dir: prior.dir } } : {}),
  };
  writeCurrentPointer(pointer, paths);
  return { pointer, switched: true };
}

export interface InstallFromDirOptions {
  fromDir: string;
  version: string;
  paths?: PreviouslyPaths;
  /** Kernel line override (tests); defaults to package.json previously.kernelLine. */
  line?: string;
}

/**
 * `previously kernel install --from <dir> --version <x.y.z>` — escape hatch
 * that treats a local directory as an already-built standalone artifact.
 * Skips clone+build entirely (this is how tests exercise the full
 * install/switch/rollback logic without building Next.js).
 */
export function installFromDir(opts: InstallFromDirOptions): InstallResult {
  const paths = opts.paths ?? resolvePaths();
  const parsed = parseSemver(opts.version);
  if (!parsed) {
    throw new Error(`Invalid --version "${opts.version}" (expected x.y.z)`);
  }
  const version = formatSemver(parsed);
  const compat = checkCompat(version, opts.line);
  if (!compat.ok) throw new Error(compat.message);
  if (!existsSync(opts.fromDir)) {
    throw new Error(`--from directory does not exist: ${opts.fromDir}`);
  }
  return stageAndSwitch(opts.fromDir, version, paths);
}

export interface InstallFromRepoOptions {
  repo: string;
  ref: string;
  paths?: PreviouslyPaths;
  exec?: ExecFn;
  line?: string;
}

/**
 * `previously kernel install --repo <url> --ref <ref>` — shallow-clone the
 * agent repo at ref, `pnpm install --frozen-lockfile && pnpm build`, read the
 * real kernel version from src/lib/version/constants.ts (package.json there
 * is stale), then install .next/standalone/ into versions/<version>/.
 */
export function installFromRepo(opts: InstallFromRepoOptions): InstallResult {
  const paths = opts.paths ?? resolvePaths();
  const exec = opts.exec ?? defaultExec;
  const cacheDir = paths.agentRepoCacheDir;

  // Fresh clone every install: no stale cache state to reason about. The
  // clone is left in place afterwards as a cache/debug aid and wiped at the
  // start of the next install.
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(dirname(cacheDir), { recursive: true });

  // --branch covers branches and tags; a bare commit sha needs fetch+checkout.
  const clone = exec(
    'git',
    ['clone', '--depth', '1', '--branch', opts.ref, opts.repo, cacheDir],
  );
  if (clone.error) {
    throw new Error(`Failed to run \`git\`: ${clone.error.message}. git must be on PATH.`);
  }
  if (clone.status !== 0) {
    rmSync(cacheDir, { recursive: true, force: true });
    runOrThrow(exec, 'git', ['clone', '--depth', '1', opts.repo, cacheDir]);
    runOrThrow(exec, 'git', ['fetch', '--depth', '1', 'origin', opts.ref], cacheDir);
    runOrThrow(exec, 'git', ['checkout', 'FETCH_HEAD'], cacheDir);
  }

  runOrThrow(exec, 'pnpm', ['install', '--frozen-lockfile'], cacheDir);
  runOrThrow(exec, 'pnpm', ['build'], cacheDir);

  const constantsPath = join(cacheDir, 'src', 'lib', 'version', 'constants.ts');
  if (!existsSync(constantsPath)) {
    throw new Error(
      `Kernel version source not found: ${constantsPath}. ` +
        `The agent repo must carry the real version in src/lib/version/constants.ts.`,
    );
  }
  const version = parseKernelVersionFromSource(readFileSync(constantsPath, 'utf8'));
  if (!version) {
    throw new Error(`Could not parse a version (x.y.z) from ${constantsPath}`);
  }
  const compat = checkCompat(version, opts.line);
  if (!compat.ok) throw new Error(compat.message);

  const standaloneDir = join(cacheDir, '.next', 'standalone');
  return stageAndSwitch(standaloneDir, version, paths);
}

/**
 * `previously kernel rollback` — flip the pointer back to the previous
 * version. The two most recent installs swap places, so a mistaken rollback
 * can itself be rolled back.
 */
export function rollback(paths: PreviouslyPaths = resolvePaths()): KernelPointer {
  const current = readCurrentPointer(paths);
  if (!current) {
    throw new Error('No kernel is installed — nothing to roll back.');
  }
  if (!current.previous) {
    throw new Error(
      `Kernel ${current.version} is the only installed version — there is no previous version to roll back to.`,
    );
  }
  const pointer: KernelPointer = {
    version: current.previous.version,
    dir: current.previous.dir,
    previous: { version: current.version, dir: current.dir },
  };
  writeCurrentPointer(pointer, paths);
  return pointer;
}

export interface ResolvedKernel {
  dir: string;
  /** Null when the version cannot be determined (hand-placed artifact without a marker). */
  version: string | null;
  source: 'config-override' | 'pointer' | 'default';
}

/**
 * Resolve which kernel directory `start`/`status` should use:
 * an explicit config `kernelDir` wins (override); otherwise the current
 * pointer; otherwise the legacy default dir (hand-placed artifacts, C1 flow).
 */
export function resolveKernel(
  configKernelDir: string | undefined,
  paths: PreviouslyPaths = resolvePaths(),
): ResolvedKernel {
  if (configKernelDir) {
    return {
      dir: configKernelDir,
      version: readKernelVersionFromDir(configKernelDir),
      source: 'config-override',
    };
  }
  const pointer = readCurrentPointer(paths);
  if (pointer) {
    return { dir: pointer.dir, version: pointer.version, source: 'pointer' };
  }
  return {
    dir: paths.kernelDir,
    version: readKernelVersionFromDir(paths.kernelDir),
    source: 'default',
  };
}
