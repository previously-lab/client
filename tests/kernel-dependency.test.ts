import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as kernelCmd } from '../src/commands/kernel.js';
import {
  installFromDependency,
  installFromDir,
  listInstalledVersions,
  readCurrentPointer,
  type KernelPackageResolver,
} from '../src/lib/kernel.js';
import { resolvePaths } from '../src/lib/paths.js';
import { getPinnedKernelVersion } from '../src/lib/version-policy.js';
import { cleanupTempHome, useTempHome, writeStandaloneFixture } from './helpers.js';

/** The on-pin fixture version — always the version this client ships pinned to. */
const PIN = getPinnedKernelVersion();
/** A version that is never the pin — used for off-pin refusal tests. */
const OFF_PIN = PIN.replace(/(\d+)$/, (p) => String(Number(p) + 1));

/** Build a fake @previously-lab/kernel npm package: package.json + a minimal standalone/ tree. */
function makeKernelPackage(
  home: string,
  version: string,
  opts: { withStandalone?: boolean } = {},
): string {
  const root = join(home, 'fake-node-modules', '@previously-lab', 'kernel');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@previously-lab/kernel', version }, null, 2) + '\n',
    'utf8',
  );
  if (opts.withStandalone ?? true) {
    writeStandaloneFixture(join(root, 'standalone'));
  }
  return root;
}

describe('kernel install from the @previously-lab/kernel dependency', () => {
  let home: string;
  let stderr: string[];
  let stdout: string[];

  beforeEach(() => {
    home = useTempHome();
    stderr = [];
    stdout = [];
    vi.spyOn(console, 'error').mockImplementation((msg) => stderr.push(String(msg)));
    vi.spyOn(console, 'log').mockImplementation((msg) => stdout.push(String(msg)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempHome(home);
  });

  it('installs the dependency artifact: files land, marker written, pointer flips', () => {
    const root = makeKernelPackage(home, PIN);
    const { pointer } = installFromDependency({ resolvePackageRoot: () => root });

    const paths = resolvePaths();
    expect(pointer.version).toBe(PIN);
    expect(pointer.dir).toBe(join(paths.kernelVersionsDir, PIN));
    expect(existsSync(join(pointer.dir, 'server.js'))).toBe(true);
    expect(existsSync(join(pointer.dir, 'previously-kernel.json'))).toBe(true);
    expect(readCurrentPointer(paths)).toEqual(pointer);
    expect(listInstalledVersions(paths)).toEqual([PIN]);
  });

  it('a missing @previously-lab/kernel dependency fails with an actionable message', () => {
    // The dev workspace resolves @previously-lab/kernel from npm like any
    // consumer, so the global "package is absent" premise no longer holds
    // here; simulate the missing dependency through the resolver seam instead.
    const missing: KernelPackageResolver = () => {
      throw new Error(
        'The @previously-lab/kernel package is not installed — your @previously-lab/client ' +
          'install looks incomplete. Reinstall the client (`npm i -g @previously-lab/client`), ' +
          'or install the kernel from a local artifact (`--from <dir>`) or from source (`--repo`).',
      );
    };
    expect(() => installFromDependency({ resolvePackageRoot: missing })).toThrow(/npm i -g @previously-lab\/client/);
    expect(() => installFromDependency({ resolvePackageRoot: missing })).toThrow(/--from/);
    expect(readCurrentPointer()).toBeNull();
  });

  it('an off-pin dependency version is refused and the pointer is untouched', () => {
    const root = makeKernelPackage(home, OFF_PIN);
    expect(() => installFromDependency({ resolvePackageRoot: () => root })).toThrow(
      /npm i -g @previously-lab\/client@latest/,
    );
    expect(readCurrentPointer()).toBeNull();
    expect(listInstalledVersions()).toEqual([]);
  });

  it('a dependency package without standalone/ fails honestly', () => {
    const root = makeKernelPackage(home, PIN, { withStandalone: false });
    expect(() => installFromDependency({ resolvePackageRoot: () => root })).toThrow(/standalone/);
    expect(() => installFromDependency({ resolvePackageRoot: () => root })).toThrow(
      /npm i -g @previously-lab\/client/,
    );
    expect(readCurrentPointer()).toBeNull();
  });

  it('a dependency package.json without a valid version fails honestly', () => {
    const root = makeKernelPackage(home, 'banana');
    expect(() => installFromDependency({ resolvePackageRoot: () => root })).toThrow(
      /Could not read a version/,
    );
    expect(readCurrentPointer()).toBeNull();
  });

  it('--from regression: the escape hatch still installs a local artifact', () => {
    const src = writeStandaloneFixture(join(home, 'src-fixtures', 'from'));
    const { pointer } = installFromDir({ fromDir: src, version: PIN });
    expect(pointer.version).toBe(PIN);
    expect(readCurrentPointer()).toEqual(pointer);
  });

  it('kernel install (default) uses the dependency path', async () => {
    const root = makeKernelPackage(home, PIN);
    expect(await kernelCmd(['install'], { resolvePackageRoot: () => root })).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain(`Installed kernel ${PIN}`);
    expect(out).toContain('@previously-lab/kernel');
    expect(readCurrentPointer()?.version).toBe(PIN);
  });

  it('kernel install surfaces a missing dependency as a clean error, exit 1', async () => {
    const missing: KernelPackageResolver = () => {
      throw new Error(
        'The @previously-lab/kernel package is not installed — your @previously-lab/client ' +
          'install looks incomplete. Reinstall the client (`npm i -g @previously-lab/client`), ' +
          'or install the kernel from a local artifact (`--from <dir>`) or from source (`--repo`).',
      );
    };
    expect(await kernelCmd(['install'], { resolvePackageRoot: missing })).toBe(1);
    expect(stderr.join('\n')).toContain('npm i -g @previously-lab/client');
    expect(readCurrentPointer()).toBeNull();
  });

  it('kernel install refuses --version on the dependency path', async () => {
    const root = makeKernelPackage(home, PIN);
    expect(
      await kernelCmd(['install', '--version', PIN], { resolvePackageRoot: () => root }),
    ).toBe(1);
    const message = stderr.join('\n');
    expect(message).toContain('--version');
    expect(message).toContain('@previously-lab/kernel');
    expect(readCurrentPointer()).toBeNull();
  });

  it('kernel install --from regression at the command layer', async () => {
    const src = writeStandaloneFixture(join(home, 'src-fixtures', 'cmd-from'));
    expect(await kernelCmd(['install', '--from', src, '--version', PIN])).toBe(0);
    expect(stdout.join('\n')).toContain(`Installed kernel ${PIN}`);
    expect(readCurrentPointer()?.version).toBe(PIN);
  });
});
