import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig, defaultConfig } from '../src/lib/config.js';
import { resolvePaths } from '../src/lib/paths.js';

/**
 * Create a fresh temp dir, point PREVIOUSLY_HOME at it, and return the dir.
 * Call cleanupTempHome() in afterEach.
 */
export function useTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'previously-test-'));
  process.env.PREVIOUSLY_HOME = dir;
  return dir;
}

export function cleanupTempHome(dir: string): void {
  delete process.env.PREVIOUSLY_HOME;
  // Windows releases file handles asynchronously after a kill, and antivirus
  // scan-on-close can hold the just-written kernel.log well beyond any sane
  // retry window. Retry generously, but never fail an otherwise-green test on
  // a leftover temp dir — warn and leave it for the OS temp cleaner.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  } catch (err) {
    console.warn(
      `cleanupTempHome: could not remove ${dir} (${err instanceof Error ? err.message : err}); leaving it behind`,
    );
  }
}

/** A minimal stand-in for the real kernel standalone build: an HTTP server on PORT/HOSTNAME. */
export const FIXTURE_KERNEL = `const http = require('node:http');
const port = Number(process.env.PORT || 3210);
const host = process.env.HOSTNAME || '127.0.0.1';
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('previously fixture kernel\\n');
});
server.listen(port, host, () => console.log('fixture kernel listening on ' + host + ':' + port));
`;

/** Place the fixture kernel at <home>/kernel/server.js (the default kernelDir). */
export function writeFixtureKernel(home: string): void {
  const kernelDir = join(home, 'kernel');
  mkdirSync(kernelDir, { recursive: true });
  writeFileSync(join(kernelDir, 'server.js'), FIXTURE_KERNEL, 'utf8');
}

/**
 * Write the fixture kernel as a standalone artifact into an arbitrary
 * directory — input for `previously kernel install --from <dir>`.
 */
export function writeStandaloneFixture(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'server.js'), FIXTURE_KERNEL, 'utf8');
  return dir;
}

/** Write a config with the given port into the current PREVIOUSLY_HOME. */
export function writeConfigWithPort(port: number): void {
  const paths = resolvePaths();
  saveConfig({ ...defaultConfig(paths), port }, paths);
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** A pid that is guaranteed dead (a process that already exited). */
export function getDeadPid(): number {
  const res = spawnSync(process.execPath, ['-e', '']);
  if (res.pid === undefined) throw new Error('spawnSync did not return a pid');
  return res.pid;
}

/**
 * Write a small but realistic episodic memory tree under <home>/memory,
 * matching the agent repo's on-disk layout:
 *   episodic/timeline.md, episodic/timeline/index.json, episodic/strands.json
 *   episodic/slices/YYYY/MM/DD/HHMM/timeline/core.md (+ _index.json per month)
 * Returns the memory root.
 */
export function writeFixtureMemory(home: string): string {
  const memory = join(home, 'memory');
  const sliceDir = join(memory, 'episodic', 'slices', '2026', '08', '10', '1401', 'timeline');
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(
    join(sliceDir, 'core.md'),
    [
      '---',
      'slice_id: 2026-08-10-1401',
      'status: closed',
      'tags: [面试, 自我进化]',
      '---',
      '## Turn a1b2c3 — 2026-08-10T14:01:00.000Z (user)',
      '',
      '帮我准备周五 Apex Intelligence 的面试',
      '',
      '## Turn d4e5f6 — 2026-08-10T14:01:30.000Z (agent)',
      '',
      '好的，我们先从自进化这个主题开始。',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(memory, 'episodic', 'slices', '2026', '08', '_index.json'),
    JSON.stringify(
      {
        month: '2026-08',
        slices: [
          {
            slice_id: '2026-08-10-1401',
            summary: '面试准备：Apex Intelligence 自进化',
            tags: ['面试', '自我进化'],
          },
        ],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  writeFileSync(
    join(memory, 'episodic', 'timeline.md'),
    [
      '# Timeline',
      '',
      '## 2026-08',
      '### 08-10',
      '- **2026-08-10-1401** 面试准备：Apex Intelligence 自进化 · 2轮 [面试,自我进化]',
      '### 08-09',
      '- **2026-08-09-1546** 版本更新讨论 · 3轮 [项目开发]',
      '',
      '## 2026-07',
      '### 07-28',
      '- **2026-07-28-0658** 第一次见面 · 2轮',
      '',
    ].join('\n'),
    'utf8',
  );
  mkdirSync(join(memory, 'episodic', 'timeline'), { recursive: true });
  writeFileSync(
    join(memory, 'episodic', 'timeline', 'index.json'),
    JSON.stringify({ _schema: 1, slice_count: 1, slices: [{ id: '2026-08-10-1401' }] }, null, 2) + '\n',
    'utf8',
  );
  writeFileSync(
    join(memory, 'episodic', 'strands.json'),
    JSON.stringify(
      {
        面试准备: ['2026/08/10/1401'],
        项目开发: ['2026/08/09/1546', '2026/08/10/1700'],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  return memory;
}
