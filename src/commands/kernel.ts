import { parseArgs } from 'node:util';
import {
  DEFAULT_KERNEL_REPO,
  installFromDir,
  installFromRepo,
  listInstalledVersions,
  readCurrentPointer,
  type ExecFn,
} from '../lib/kernel.js';
import { resolvePaths } from '../lib/paths.js';

export interface KernelCommandDeps {
  /** Shell-out seam for tests; defaults to real spawnSync-based exec. */
  exec?: ExecFn;
}

function usage(): void {
  console.log(`previously kernel — manage the pinned kernel version

Usage: previously kernel <subcommand>

Subcommands:
  install   Install the pinned kernel version and switch to it
            --from <dir> --version <x.y.z>   use an already-built standalone dir (skips clone+build)
            --repo <git-url>                 clone & build the pinned tag from the agent repo
            (defaults: --repo ${DEFAULT_KERNEL_REPO})
  list      List installed kernel versions (* marks the current one)
  current   Show the active kernel version

The client is pinned to one exact kernel version (package.json
previously.kernelVersion); upgrading means upgrading the client package.

Requires git (and, for repo builds, pnpm) on PATH.
`);
}

/**
 * `previously kernel …` — install/list/current subcommands for the
 * versioned kernel supply chain (design doc §10.1/§10.2).
 */
export async function run(args: string[], deps: KernelCommandDeps = {}): Promise<number> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case 'install':
        return install(rest, deps);
      case 'list':
        return list();
      case 'current':
        return current();
      default:
        if (sub === '--help' || sub === '-h') {
          usage();
          return 0;
        }
        if (sub !== undefined) console.error(`Unknown kernel subcommand: ${sub}`);
        usage();
        return 1;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function install(args: string[], deps: KernelCommandDeps): number {
  const { values } = parseArgs({
    args,
    options: {
      from: { type: 'string' },
      version: { type: 'string' },
      repo: { type: 'string' },
    },
  });

  if (values.from !== undefined) {
    if (values.version === undefined) {
      console.error('--from requires an explicit --version <x.y.z> (the local dir carries no version metadata we trust)');
      return 1;
    }
    const { pointer } = installFromDir({ fromDir: values.from, version: values.version });
    console.log(`Installed kernel ${pointer.version} from ${values.from}`);
    console.log(`Current kernel is now ${pointer.version} (${pointer.dir})`);
    return 0;
  }

  const repo = values.repo ?? DEFAULT_KERNEL_REPO;
  console.log(`Building the pinned kernel from ${repo} (this can take a few minutes)…`);
  const { pointer } = installFromRepo({ repo, exec: deps.exec });
  console.log(`Installed kernel ${pointer.version}`);
  console.log(`Current kernel is now ${pointer.version} (${pointer.dir})`);
  return 0;
}

function list(): number {
  const paths = resolvePaths();
  const versions = listInstalledVersions(paths);
  const pointer = readCurrentPointer(paths);
  if (versions.length === 0) {
    console.log('No kernel versions installed. Run `previously kernel install`.');
    return 0;
  }
  for (const v of versions) {
    console.log(`${pointer?.version === v ? '*' : ' '} ${v}`);
  }
  return 0;
}

function current(): number {
  const pointer = readCurrentPointer(resolvePaths());
  if (!pointer) {
    console.log('No kernel installed. Run `previously kernel install`.');
    return 1;
  }
  console.log(`${pointer.version} (${pointer.dir})`);
  return 0;
}
