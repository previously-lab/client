import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run as status } from '../src/commands/status.js';
import { ensureMemoryRepo } from '../src/lib/memory-repo.js';
import { collectStatus, nextStepSuggestion } from '../src/lib/system-status.js';
import { resolvePaths } from '../src/lib/paths.js';
import { writePidFile } from '../src/lib/process.js';
import { cleanupTempHome, getDeadPid, getFreePort, useTempHome, writeConfigWithPort } from './helpers.js';

describe('status next-step suggestion', () => {
  let home: string;
  let stdout: string[];
  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempHome(home);
  });

  it('suggests init when not initialized', async () => {
    home = useTempHome();
    const s = await collectStatus(resolvePaths());
    expect(nextStepSuggestion(s)).toContain('previously init');
  });

  it('suggests `previously start` when initialized but the kernel is down', async () => {
    home = useTempHome();
    writeConfigWithPort(await getFreePort());
    const s = await collectStatus(resolvePaths());
    expect(nextStepSuggestion(s)).toBe('run `previously start` to start the kernel');
  });

  it('suggests a restart when the kernel runs but the scribe is dead', async () => {
    home = useTempHome();
    writeConfigWithPort(await getFreePort());
    writePidFile(resolvePaths().pidPath, process.pid); // kernel "alive"
    writePidFile(resolvePaths().scribePidPath, getDeadPid()); // scribe dead
    const s = await collectStatus(resolvePaths());
    expect(nextStepSuggestion(s)).toContain('previously stop && previously');
  });

  it('suggests upgrading the client package when the kernel is off the pin', async () => {
    home = useTempHome();
    writeConfigWithPort(await getFreePort());
    writePidFile(resolvePaths().pidPath, process.pid); // kernel "alive"
    writePidFile(resolvePaths().scribePidPath, process.pid); // scribe "alive"
    const paths = resolvePaths();
    mkdirSync(paths.kernelDir, { recursive: true });
    writeFileSync(
      paths.kernelCurrentPath,
      JSON.stringify({ version: '0.10.0', dir: paths.kernelDir }),
      'utf8',
    );
    const s = await collectStatus(resolvePaths());
    expect(s.compat?.ok).toBe(false);
    expect(nextStepSuggestion(s)).toContain('upgrade the client package');
    expect(nextStepSuggestion(s)).not.toContain('previously upgrade');
  });

  it('status output ends with the suggestion line', async () => {
    home = useTempHome();
    writeConfigWithPort(await getFreePort());
    stdout = [];
    vi.spyOn(console, 'log').mockImplementation((m) => stdout.push(String(m)));
    expect(await status([])).toBe(1);
    const nextLine = stdout.find((l) => l.startsWith('Next:'));
    expect(nextLine).toContain('run `previously start` to start the kernel');
  });

  it('status shows the memory repo line (branch, changes, last commit)', async () => {
    home = useTempHome();
    writeConfigWithPort(await getFreePort());
    const paths = resolvePaths();
    await ensureMemoryRepo(paths.memoryDir);
    stdout = [];
    vi.spyOn(console, 'log').mockImplementation((m) => stdout.push(String(m)));
    expect(await status([])).toBe(1); // kernel down — but the panel renders
    const line = stdout.flatMap((l) => l.split('\n')).find((l) => l.startsWith('Memory repo:'));
    expect(line).toContain('main');
    expect(line).toContain('clean');
    expect(line).toContain('last commit');
  });

  it('status says "not a git repository" (with an init hint) when the memory root has no .git', async () => {
    home = useTempHome();
    writeConfigWithPort(await getFreePort());
    stdout = [];
    vi.spyOn(console, 'log').mockImplementation((m) => stdout.push(String(m)));
    expect(await status([])).toBe(1);
    const line = stdout.flatMap((l) => l.split('\n')).find((l) => l.startsWith('Memory repo:'));
    expect(line).toContain('not a git repository');
    expect(line).toContain('previously init');
  });
});
