import { parseArgs } from 'node:util';
import {
  DEFAULT_KERNEL_REPO,
  installFromDependency,
  installFromDir,
  installFromRepo,
  listInstalledVersions,
  readCurrentPointer,
  type ExecFn,
  type KernelPackageResolver,
} from '../lib/kernel.js';
import { resolvePaths } from '../lib/paths.js';
import { bold, cmd, emph, err as errText, green, info, muted, ok, styleHelp } from '../lib/ansi.js';

export interface KernelCommandDeps {
  /** Shell-out seam for tests (repo builds); defaults to real spawnSync-based exec. */
  exec?: ExecFn;
  /** @previously-lab/kernel dependency resolver seam for tests; defaults to require.resolve. */
  resolvePackageRoot?: KernelPackageResolver;
}

function usage(): void {
  console.log(styleHelp(`previously kernel — manage the pinned kernel version

Usage: previously kernel <subcommand>

Subcommands:
  install   Install the pinned kernel version and switch to it
            (default)                          install from the pinned @previously-lab/kernel npm
                                               dependency — zero build tools needed; the kernel
                                               version is the dependency's package version
                                               (--version is only used together with --from)
            --from <dir> --version <x.y.z>     use an already-built standalone dir
            --repo [git-url]                   developer: clone & build the pinned tag from source
                                               (default repo: ${DEFAULT_KERNEL_REPO})
  list      List installed kernel versions (* marks the current one)
  current   Show the active kernel version

The client is pinned to one exact kernel version (package.json
previously.kernelVersion); upgrading means upgrading the client package.

The default install needs no external tools; --repo requires git and pnpm on PATH.
`));
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
        if (sub !== undefined) console.error(errText(`Unknown kernel subcommand: ${sub}`));
        usage();
        return 1;
    }
  } catch (err) {
    console.error(errText(err instanceof Error ? err.message : String(err)));
    return 1;
  }
}

function install(args: string[], deps: KernelCommandDeps): number {
  // --repo is extracted manually (before parseArgs) so it can be passed
  // without a value, falling back to DEFAULT_KERNEL_REPO.
  const rest = [...args];
  let repo: string | null = null;
  const repoIdx = rest.findIndex((a) => a === '--repo' || a.startsWith('--repo='));
  if (repoIdx !== -1) {
    const tok = rest[repoIdx]!;
    if (tok.startsWith('--repo=')) {
      repo = tok.slice('--repo='.length);
      rest.splice(repoIdx, 1);
    } else {
      const next = rest[repoIdx + 1];
      const hasValue = next !== undefined && !next.startsWith('-');
      repo = hasValue ? next : DEFAULT_KERNEL_REPO;
      rest.splice(repoIdx, hasValue ? 2 : 1);
    }
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      from: { type: 'string' },
      version: { type: 'string' },
    },
  });

  if (values.from !== undefined) {
    if (values.version === undefined) {
      console.error(errText('--from requires an explicit --version <x.y.z> (the local dir carries no version metadata we trust)'));
      return 1;
    }
    const { pointer } = installFromDir({ fromDir: values.from, version: values.version });
    console.log(ok(`Installed kernel ${pointer.version} from ${emph(values.from)}`));
    console.log(`Current kernel is now ${bold(pointer.version)} (${emph(pointer.dir)})`);
    return 0;
  }

  if (repo !== null) {
    console.log(info(`Building the pinned kernel from ${repo} (this can take a few minutes)…`));
    const { pointer } = installFromRepo({ repo, exec: deps.exec });
    console.log(ok(`Installed kernel ${pointer.version}`));
    console.log(`Current kernel is now ${bold(pointer.version)} (${emph(pointer.dir)})`);
    return 0;
  }

  // Default path: install from the pinned @previously-lab/kernel npm dependency.
  // The version is pinned by that dependency; --version only makes sense with --from.
  if (values.version !== undefined) {
    console.error(errText(
      '--version is only used together with --from. The default install takes the kernel ' +
        'version pinned by the @previously-lab/kernel dependency.',
    ));
    return 1;
  }
  const { pointer } = installFromDependency({ resolvePackageRoot: deps.resolvePackageRoot });
  console.log(ok(`Installed kernel ${pointer.version} from the pinned ${emph('@previously-lab/kernel')} dependency`));
  console.log(`Current kernel is now ${bold(pointer.version)} (${emph(pointer.dir)})`);
  return 0;
}

function list(): number {
  const paths = resolvePaths();
  const versions = listInstalledVersions(paths);
  const pointer = readCurrentPointer(paths);
  if (versions.length === 0) {
    console.log(muted('No kernel versions installed. Run ') + cmd('`previously kernel install`') + muted('.'));
    return 0;
  }
  for (const v of versions) {
    const isCurrent = pointer?.version === v;
    console.log(`${isCurrent ? green('*') : ' '} ${isCurrent ? bold(v) : v}`);
  }
  return 0;
}

function current(): number {
  const pointer = readCurrentPointer(resolvePaths());
  if (!pointer) {
    console.log(errText('No kernel installed. Run `previously kernel install`.'));
    return 1;
  }
  console.log(`${bold(pointer.version)} (${emph(pointer.dir)})`);
  return 0;
}
