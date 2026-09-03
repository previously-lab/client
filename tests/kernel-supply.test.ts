import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as kernelCmd } from '../src/commands/kernel.js';
import { run as start } from '../src/commands/start.js';
import { run as status } from '../src/commands/status.js';
import { run as stop } from '../src/commands/stop.js';
import {
  installFromDir,
  listInstalledVersions,
  readCurrentPointer,
} from '../src/lib/kernel.js';
import { resolvePaths } from '../src/lib/paths.js';
import { getPinnedKernelVersion } from '../src/lib/version-policy.js';
import {
  cleanupTempHome,
  getFreePort,
  useTempHome,
  writeConfigWithPort,
  writeStandaloneFixture,
} from './helpers.js';

/** The on-pin fixture version — always the version this client ships pinned to. */
const PIN = getPinnedKernelVersion();
/** A version that is never the pin — used for off-pin refusal tests. */
const OFF_PIN = PIN.replace(/(\d+)$/, (p) => String(Number(p) + 1));

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
    const { pointer } = installFromDir({ fromDir: src, version: PIN });

    const paths = resolvePaths();
    expect(pointer.version).toBe(PIN);
    expect(pointer.dir).toBe(join(paths.kernelVersionsDir, PIN));
    expect(existsSync(join(pointer.dir, 'server.js'))).toBe(true);
    expect(existsSync(join(pointer.dir, 'previously-kernel.json'))).toBe(true);
    expect(readCurrentPointer(paths)).toEqual(pointer);
    expect(listInstalledVersions(paths)).toEqual([PIN]);
  });

  it('install --from requires a valid pinned version', () => {
    const src = makeSourceDir(home, 'b');
    expect(() => installFromDir({ fromDir: src, version: 'banana' })).toThrow(/Invalid --version/);
    expect(readCurrentPointer()).toBeNull();
  });

  it('install refuses a kernel off the pinned version, pointer untouched', () => {
    const src = makeSourceDir(home, 'c');
    expect(() => installFromDir({ fromDir: src, version: OFF_PIN })).toThrow(
      /npm i -g @previously-lab\/client@latest/,
    );
    expect(readCurrentPointer()).toBeNull();
    expect(listInstalledVersions()).toEqual([]);
  });

  it('install refuses a missing artifact dir honestly', () => {
    expect(() => installFromDir({ fromDir: join(home, 'nope'), version: PIN })).toThrow(
      /does not exist/,
    );
    expect(readCurrentPointer()).toBeNull();
  });

  it('a corrupt current.json fails with an actionable message, not a raw SyntaxError', () => {
    const paths = resolvePaths();
    mkdirSync(paths.kernelDir, { recursive: true });
    writeFileSync(paths.kernelCurrentPath, '{garbage', 'utf8');

    expect(() => readCurrentPointer(paths)).toThrow(/not valid JSON/);
    expect(() => readCurrentPointer(paths)).toThrow(/previously kernel install/);
  });

  it('a failed install leaves the previous pointer and versions intact (atomic switch)', () => {
    const good = makeSourceDir(home, 'good');
    installFromDir({ fromDir: good, version: PIN });
    const before = readCurrentPointer();

    // An "artifact" without server.js fails mid-install (pinned override
    // stands in for a second compatible version, which the exact pin forbids).
    const bad = join(home, 'src-fixtures', 'bad');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'README.txt'), 'not a kernel', 'utf8');

    expect(() => installFromDir({ fromDir: bad, version: '1.1.0', pinned: '1.1.0' })).toThrow(/server\.js/);
    expect(readCurrentPointer()).toEqual(before);
    expect(listInstalledVersions()).toEqual([PIN]);
    // No staging dirs left behind.
    expect(existsSync(join(resolvePaths().kernelVersionsDir, '.staging-1.1.0-' + process.pid))).toBe(false);
  });

  it('installing the same version twice is refused', () => {
    const src = makeSourceDir(home, 'dup');
    installFromDir({ fromDir: src, version: PIN });
    expect(() => installFromDir({ fromDir: src, version: PIN })).toThrow(/already installed/);
    expect(readCurrentPointer()?.version).toBe(PIN);
  });

  it('kernel command: install --from, current, list', async () => {
    const src = makeSourceDir(home, 'cmd');
    expect(await kernelCmd(['install', '--from', src, '--version', PIN])).toBe(0);
    expect(stdout.join('\n')).toContain(`Installed kernel ${PIN}`);

    stdout = [];
    expect(await kernelCmd(['current'])).toBe(0);
    expect(stdout.join('\n')).toContain(PIN);

    stdout = [];
    expect(await kernelCmd(['list'])).toBe(0);
    expect(stdout.join('\n')).toContain(`* ${PIN}`);
  });

  it('kernel command: the rollback subcommand is gone', async () => {
    expect(await kernelCmd(['rollback'])).toBe(1);
    expect(stderr.join('\n')).toContain('Unknown kernel subcommand: rollback');
  });

  it('kernel install --from without --version is refused', async () => {
    const src = makeSourceDir(home, 'nover');
    expect(await kernelCmd(['install', '--from', src])).toBe(1);
    expect(stderr.join('\n')).toContain('--version');
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
    installFromDir({ fromDir: makeSourceDir(home, 'run'), version: PIN });
    writeConfigWithPort(port);
    // status exits non-zero when the scribe is missing beside a live kernel;
    // run a stand-in scribe entry so the full system is healthy.
    const scribeEntry = join(home, 'fixture-scribe.js');
    writeFileSync(scribeEntry, 'setInterval(() => {}, 1000);\n', 'utf8');

    expect(await start([], { healthTimeoutMs: 15_000, scribeEntry })).toBe(0);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('fixture kernel');

    stdout = [];
    expect(await status([])).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain(PIN);
    expect(out).toContain('compatible');
    expect(out).toContain('running');

    expect(await stop([], { graceTimeoutMs: 5_000 })).toBe(0);
  });

  it('start refuses an off-pin kernel with the upgrade-client message', async () => {
    const paths = resolvePaths();
    const badDir = writeStandaloneFixture(join(paths.kernelVersionsDir, '0.10.0'));
    mkdirSync(paths.kernelDir, { recursive: true });
    writeFileSync(
      paths.kernelCurrentPath,
      JSON.stringify({ version: '0.10.0', dir: badDir }),
      'utf8',
    );
    writeConfigWithPort(port);

    expect(await start([], { healthTimeoutMs: 5_000, startScribe: false })).toBe(1);
    const message = stderr.join('\n');
    expect(message).toContain('0.10.0');
    expect(message).toContain('npm i -g @previously-lab/client@latest');
    expect(message).not.toContain('previously upgrade');
    expect(existsSync(paths.pidPath)).toBe(false);
  });

  it('status flags an off-pin kernel and exits 1', async () => {
    const paths = resolvePaths();
    const badDir = writeStandaloneFixture(join(paths.kernelVersionsDir, '0.10.0'));
    mkdirSync(paths.kernelDir, { recursive: true });
    writeFileSync(
      paths.kernelCurrentPath,
      JSON.stringify({ version: '0.10.0', dir: badDir }),
      'utf8',
    );
    writeConfigWithPort(port);

    expect(await status([])).toBe(1);
    expect(stdout.join('\n')).toContain('INCOMPATIBLE');
    expect(stderr.join('\n')).toContain('npm i -g @previously-lab/client@latest');
  });
});
