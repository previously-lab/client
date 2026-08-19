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
