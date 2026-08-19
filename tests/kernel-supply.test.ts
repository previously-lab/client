import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as kernelCmd } from '../src/commands/kernel.js';
import { run as start } from '../src/commands/start.js';
import { run as status } from '../src/commands/status.js';
import { run as stop } from '../src/commands/stop.js';
import { run as upgrade } from '../src/commands/upgrade.js';
import {
  installFromDir,
  listInstalledVersions,
  readCurrentPointer,
  rollback,
  type ExecFn,
} from '../src/lib/kernel.js';
import { resolvePaths } from '../src/lib/paths.js';
import {
  cleanupTempHome,
  getFreePort,
  useTempHome,
  writeConfigWithPort,
  writeStandaloneFixture,
} from './helpers.js';

/** Build a fixture standalone artifact as an install source (inside the sandboxed home). */
function makeSourceDir(home: string, name: string): string {
  return writeStandaloneFixture(join(home, 'src-fixtures', name));
}

describe('kernel supply chain', () => {
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

  afterEach(async () => {
    vi.restoreAllMocks();
    await stop([], { graceTimeoutMs: 3_000 });
    cleanupTempHome(home);
  });

  it('install --from stages the artifact, writes the marker, and flips the pointer', () => {
    const src = makeSourceDir(home, 'a');
    const { pointer } = installFromDir({ fromDir: src, version: '0.8.1' });

    const paths = resolvePaths();
    expect(pointer.version).toBe('0.8.1');
    expect(pointer.dir).toBe(join(paths.kernelVersionsDir, '0.8.1'));
    expect(existsSync(join(pointer.dir, 'server.js'))).toBe(true);
    expect(existsSync(join(pointer.dir, 'previously-kernel.json'))).toBe(true);
    expect(readCurrentPointer(paths)).toEqual(pointer);
    expect(listInstalledVersions(paths)).toEqual(['0.8.1']);
  });

  it('install --from requires a valid in-line version', () => {
    const src = makeSourceDir(home, 'b');
    expect(() => installFromDir({ fromDir: src, version: 'banana' })).toThrow(/Invalid --version/);
    expect(readCurrentPointer()).toBeNull();
  });

  it('install refuses a kernel from a different minor line, pointer untouched', () => {
    const src = makeSourceDir(home, 'c');
    expect(() => installFromDir({ fromDir: src, version: '0.9.0' })).toThrow(
      /npm i -g previously-client@latest/,
    );
    expect(readCurrentPointer()).toBeNull();
    expect(listInstalledVersions()).toEqual([]);
  });

  it('install refuses a missing artifact dir honestly', () => {
    expect(() => installFromDir({ fromDir: join(home, 'nope'), version: '0.8.0' })).toThrow(
      /does not exist/,
    );
    expect(readCurrentPointer()).toBeNull();
  });

  it('a failed install leaves the previous pointer and versions intact (atomic switch)', () => {
    const good = makeSourceDir(home, 'good');
    installFromDir({ fromDir: good, version: '0.8.1' });
    const before = readCurrentPointer();

    // An "artifact" without server.js fails mid-install.
    const bad = join(home, 'src-fixtures', 'bad');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'README.txt'), 'not a kernel', 'utf8');

    expect(() => installFromDir({ fromDir: bad, version: '0.8.2' })).toThrow(/server\.js/);
    expect(readCurrentPointer()).toEqual(before);
    expect(listInstalledVersions()).toEqual(['0.8.1']);
    // No staging dirs left behind.
    expect(existsSync(join(resolvePaths().kernelVersionsDir, '.staging-0.8.2-' + process.pid))).toBe(false);
  });

  it('installing the same version twice is refused', () => {
    const src = makeSourceDir(home, 'dup');
    installFromDir({ fromDir: src, version: '0.8.1' });
    expect(() => installFromDir({ fromDir: src, version: '0.8.1' })).toThrow(/already installed/);
    expect(readCurrentPointer()?.version).toBe('0.8.1');
  });

  it('rollback swaps back to the previous version, and can swap forward again', () => {
    installFromDir({ fromDir: makeSourceDir(home, 'r1'), version: '0.8.1' });
    installFromDir({ fromDir: makeSourceDir(home, 'r2'), version: '0.8.2' });
    expect(readCurrentPointer()?.version).toBe('0.8.2');

    const back = rollback();
    expect(back.version).toBe('0.8.1');
    expect(readCurrentPointer()?.version).toBe('0.8.1');
    expect(listInstalledVersions().sort()).toEqual(['0.8.1', '0.8.2']);

    const forward = rollback();
    expect(forward.version).toBe('0.8.2');
  });

  it('rollback with no previous version fails honestly', () => {
    installFromDir({ fromDir: makeSourceDir(home, 'only'), version: '0.8.1' });
    expect(() => rollback()).toThrow(/no previous version/);
    expect(readCurrentPointer()?.version).toBe('0.8.1');
  });

  it('rollback with nothing installed fails honestly', () => {
    expect(() => rollback()).toThrow(/No kernel is installed/);
  });

  it('kernel command: install --from, current, list, rollback', async () => {
    const src = makeSourceDir(home, 'cmd');
    expect(await kernelCmd(['install', '--from', src, '--version', '0.8.3'])).toBe(0);
    expect(stdout.join('\n')).toContain('Installed kernel 0.8.3');

    stdout = [];
    expect(await kernelCmd(['current'])).toBe(0);
    expect(stdout.join('\n')).toContain('0.8.3');

    stdout = [];
    expect(await kernelCmd(['list'])).toBe(0);
    expect(stdout.join('\n')).toContain('* 0.8.3');

    expect(await kernelCmd(['rollback'])).toBe(1);
    expect(stderr.join('\n')).toContain('no previous version');
  });

  it('kernel install --from without --version is refused', async () => {
    const src = makeSourceDir(home, 'nover');
    expect(await kernelCmd(['install', '--from', src])).toBe(1);
    expect(stderr.join('\n')).toContain('--version');
  });

  it('kernel install without --from or --ref is refused', async () => {
    expect(await kernelCmd(['install'])).toBe(1);
    expect(stderr.join('\n')).toContain('--ref');
  });

  it('kernel current with nothing installed exits 1', async () => {
    expect(await kernelCmd(['current'])).toBe(1);
    expect(stdout.join('\n')).toContain('No kernel installed');
  });
});

describe('start/status with the kernel pointer', () => {
  let home: string;
  let port: number;
  let stderr: string[];
  let stdout: string[];

  beforeEach(async () => {
    home = useTempHome();
    port = await getFreePort();
    stderr = [];
    stdout = [];
    vi.spyOn(console, 'error').mockImplementation((msg) => stderr.push(String(msg)));
    vi.spyOn(console, 'log').mockImplementation((msg) => stdout.push(String(msg)));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await stop([], { graceTimeoutMs: 3_000 });
    cleanupTempHome(home);
  });

  it('start launches the kernel from the pointer dir; status reports version + compat', async () => {
    installFromDir({ fromDir: makeSourceDir(home, 'run'), version: '0.8.1' });
    writeConfigWithPort(port);

    expect(await start([], { healthTimeoutMs: 15_000 })).toBe(0);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('fixture kernel');

    stdout = [];
    expect(await status([])).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain('0.8.1');
    expect(out).toContain('compatible');
    expect(out).toContain('running');

    expect(await stop([], { graceTimeoutMs: 5_000 })).toBe(0);
  });

  it('start refuses an incompatible kernel with the upgrade-client message', async () => {
    const paths = resolvePaths();
    const badDir = writeStandaloneFixture(join(paths.kernelVersionsDir, '0.9.0'));
    mkdirSync(paths.kernelDir, { recursive: true });
    writeFileSync(
      paths.kernelCurrentPath,
      JSON.stringify({ version: '0.9.0', dir: badDir }),
      'utf8',
    );
    writeConfigWithPort(port);

    expect(await start([], { healthTimeoutMs: 5_000 })).toBe(1);
    const message = stderr.join('\n');
    expect(message).toContain('0.9.0');
    expect(message).toContain('npm i -g previously-client@latest');
    expect(existsSync(paths.pidPath)).toBe(false);
  });

  it('status flags an incompatible kernel and exits 1', async () => {
    const paths = resolvePaths();
    const badDir = writeStandaloneFixture(join(paths.kernelVersionsDir, '0.9.0'));
    mkdirSync(paths.kernelDir, { recursive: true });
    writeFileSync(
      paths.kernelCurrentPath,
      JSON.stringify({ version: '0.9.0', dir: badDir }),
      'utf8',
    );
    writeConfigWithPort(port);

    expect(await status([])).toBe(1);
    expect(stdout.join('\n')).toContain('INCOMPATIBLE');
    expect(stderr.join('\n')).toContain('npm i -g previously-client@latest');
  });
});

describe('previously upgrade', () => {
  let home: string;
  let stderr: string[];
  let stdout: string[];

  const TAGS_082 = [
    'aaa111\trefs/tags/v0.8.0',
    'bbb222\trefs/tags/v0.8.1',
    'ccc333\trefs/tags/v0.8.2',
    'ccc333\trefs/tags/v0.8.2^{}',
  ].join('\n');

  function fakeExec(output: string, status = 0): ExecFn {
    return () => ({ status, stdout: output, stderr: status === 0 ? '' : 'simulated git failure' });
  }

  beforeEach(() => {
    home = useTempHome();
    stderr = [];
    stdout = [];
    vi.spyOn(console, 'error').mockImplementation((msg) => stderr.push(String(msg)));
    vi.spyOn(console, 'log').mockImplementation((msg) => stdout.push(String(msg)));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await stop([], { graceTimeoutMs: 3_000 });
    cleanupTempHome(home);
  });

  it('installs the newest in-line tag and flips the pointer', async () => {
    const calls: { repo: string; ref: string }[] = [];
    const fakeInstall = (opts: { repo: string; ref: string }) => {
      calls.push(opts);
      return installFromDir({
        fromDir: makeSourceDir(home, 'upg'),
        version: opts.ref.replace(/^v/, ''),
      });
    };

    const code = await upgrade([], { exec: fakeExec(TAGS_082), install: fakeInstall });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      repo: 'https://github.com/previously-lab/agent.git',
      ref: 'v0.8.2',
    });
    expect(readCurrentPointer()?.version).toBe('0.8.2');
    expect(stdout.join('\n')).toContain('0.8.2');
  });

  it('honors --repo override', async () => {
    const calls: { repo: string; ref: string }[] = [];
    await upgrade(['--repo', 'https://example.com/fork.git'], {
      exec: fakeExec(TAGS_082),
      install: (opts) => {
        calls.push(opts);
        return installFromDir({ fromDir: makeSourceDir(home, 'fork'), version: '0.8.2' });
      },
    });
    expect(calls[0]?.repo).toBe('https://example.com/fork.git');
  });

  it('refuses when the newest tag has crossed to a new minor line', async () => {
    installFromDir({ fromDir: makeSourceDir(home, 'cur'), version: '0.8.2' });
    const tags = TAGS_082 + '\nddd444\trefs/tags/v0.9.0';

    const code = await upgrade([], { exec: fakeExec(tags) });
    expect(code).toBe(1);
    const message = stderr.join('\n');
    expect(message).toContain('0.9.0');
    expect(message).toContain('npm i -g previously-client@latest');
    expect(readCurrentPointer()?.version).toBe('0.8.2');
  });

  it('reports already up-to-date and installs nothing', async () => {
    installFromDir({ fromDir: makeSourceDir(home, 'cur2'), version: '0.8.2' });
    let installCalled = false;
    const code = await upgrade([], {
      exec: fakeExec(TAGS_082),
      install: () => {
        installCalled = true;
        throw new Error('must not be called');
      },
    });
    expect(code).toBe(0);
    expect(installCalled).toBe(false);
    expect(stdout.join('\n')).toContain('already up to date');
  });

  it('fails honestly when git is unavailable or the repo errors', async () => {
    expect(await upgrade([], { exec: fakeExec('', 128) })).toBe(1);
    expect(stderr.join('\n')).toContain('Could not query kernel releases');
  });

  it('fails honestly when no release tags exist', async () => {
    expect(await upgrade([], { exec: fakeExec('aaa111\trefs/tags/nightly\n') })).toBe(1);
    expect(stderr.join('\n')).toContain('No kernel release tags');
  });
});
