import { parseArgs } from 'node:util';
import {
  DEFAULT_KERNEL_REPO,
  defaultExec,
  installFromRepo,
  readCurrentPointer,
  type ExecFn,
  type InstallResult,
} from '../lib/kernel.js';
import { resolvePaths } from '../lib/paths.js';
import { isProcessAlive, readPidFile } from '../lib/process.js';
import {
  formatSemver,
  getKernelLine,
  parseRemoteTags,
  selectUpgradeTarget,
} from '../lib/version-policy.js';

export interface UpgradeDeps {
  /** Shell-out seam for tests (git ls-remote is mocked through this). */
  exec?: ExecFn;
  /** Install seam for tests; defaults to a real clone+build install. */
  install?: (opts: { repo: string; ref: string; exec?: ExecFn }) => InstallResult;
}

/**
 * `previously upgrade` — query the agent repo's version tags, install the
 * newest release inside the client's kernel line, and flip the pointer.
 * Refuses honestly when the newest release has crossed to a new minor line
 * (that requires a client upgrade first). Patch-level updates are free.
 */
export async function run(args: string[], deps: UpgradeDeps = {}): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { repo: { type: 'string' } },
  });
  const repo = values.repo ?? DEFAULT_KERNEL_REPO;
  const exec = deps.exec;
  const install = deps.install ?? ((opts) => installFromRepo({ ...opts, paths: resolvePaths() }));
  const line = getKernelLine();

  const res = (exec ?? defaultExec)('git', ['ls-remote', '--tags', repo]);
  if (res.error) {
    console.error(`Failed to run \`git\`: ${res.error.message}. git must be on PATH.`);
    return 1;
  }
  if (res.status !== 0) {
    console.error(`Could not query kernel releases from ${repo}:`);
    console.error(res.stderr.trim());
    return 1;
  }

  const currentVersion = readCurrentPointer(resolvePaths())?.version ?? null;
  const target = selectUpgradeTarget(parseRemoteTags(res.stdout), line, currentVersion);

  switch (target.kind) {
    case 'no-tags':
      console.error(`No kernel release tags found at ${repo}.`);
      return 1;
    case 'crossed-line':
      console.error(target.message);
      return 1;
    case 'up-to-date':
      console.log(
        `Kernel is already up to date (${currentVersion ?? formatSemver(target.version)}, line ${line}.x).`,
      );
      return 0;
    case 'install': {
      const tag = target.release.tag;
      const version = formatSemver(target.release.version);
      console.log(
        currentVersion
          ? `Upgrading kernel ${currentVersion} → ${version} (tag ${tag})…`
          : `Installing kernel ${version} (tag ${tag})…`,
      );
      try {
        const { pointer } = install({ repo, ref: tag, exec });
        console.log(`Kernel ${pointer.version} installed and active (${pointer.dir}).`);
        if (pointer.previous) {
          console.log(`Previous version ${pointer.previous.version} kept — \`previously kernel rollback\` switches back.`);
        }
        // The pointer flipped, but a running kernel keeps serving the OLD
        // version until restarted — say so honestly.
        const pid = readPidFile(resolvePaths().pidPath);
        if (pid !== null && isProcessAlive(pid)) {
          console.log(`Note: the kernel is running (pid ${pid}) and still serving the old version — restart with \`previously stop && previously start\` to apply ${pointer.version}.`);
        }
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        console.error(`Upgrade failed; the current kernel (${currentVersion ?? 'none'}) is untouched.`);
        return 1;
      }
    }
  }
}
