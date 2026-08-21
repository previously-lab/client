import { afterEach, describe, expect, it, vi } from 'vitest';
import { run as status } from '../src/commands/status.js';
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

  it('suggests `previously` when initialized but the kernel is down', async () => {
    home = useTempHome();
    writeConfigWithPort(await getFreePort());
    const s = await collectStatus(resolvePaths());
    expect(nextStepSuggestion(s)).toBe('run `previously` to start');
  });

  it('suggests a restart when the kernel runs but the scribe is dead', async () => {
    home = useTempHome();
    writeConfigWithPort(await getFreePort());
    writePidFile(resolvePaths().pidPath, process.pid); // kernel "alive"
    writePidFile(resolvePaths().scribePidPath, getDeadPid()); // scribe dead
    const s = await collectStatus(resolvePaths());
    expect(nextStepSuggestion(s)).toContain('previously stop && previously');
  });

  it('status output ends with the suggestion line', async () => {
    home = useTempHome();
    writeConfigWithPort(await getFreePort());
    stdout = [];
    vi.spyOn(console, 'log').mockImplementation((m) => stdout.push(String(m)));
    expect(await status([])).toBe(1);
    const nextLine = stdout.find((l) => l.startsWith('Next:'));
    expect(nextLine).toContain('run `previously` to start');
  });
});
