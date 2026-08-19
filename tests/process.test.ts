import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isProcessAlive,
  readPidFile,
  removePidFile,
  terminateProcess,
  waitForExit,
  writePidFile,
} from '../src/lib/process.js';
import { cleanupTempHome, getDeadPid, useTempHome } from './helpers.js';

describe('process management', () => {
  let home: string;
  afterEach(() => cleanupTempHome(home));

  it('pid file lifecycle: write → read → remove', () => {
    home = useTempHome();
    const pidPath = join(home, 'kernel.pid');
    expect(readPidFile(pidPath)).toBeNull();

    writePidFile(pidPath, 4242);
    expect(readPidFile(pidPath)).toBe(4242);

    removePidFile(pidPath);
    expect(readPidFile(pidPath)).toBeNull();
  });

  it('a corrupt pid file reads as null', async () => {
    home = useTempHome();
    const pidPath = join(home, 'kernel.pid');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(pidPath, 'not-a-pid\n', 'utf8');
    expect(readPidFile(pidPath)).toBeNull();
    writeFileSync(pidPath, '-12\n', 'utf8');
    expect(readPidFile(pidPath)).toBeNull();
  });

  it('isProcessAlive detects live and dead processes', () => {
    home = useTempHome();
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(getDeadPid())).toBe(false);
  });

  it('waitForExit resolves once a process exits on its own', async () => {
    home = useTempHome();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], {
      stdio: 'ignore',
    });
    expect(child.pid).toBeDefined();
    expect(await waitForExit(child.pid!, 10_000)).toBe(true);
  });

  it('terminateProcess kills a running process', async () => {
    home = useTempHome();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const pid = child.pid!;
    expect(isProcessAlive(pid)).toBe(true);
    await terminateProcess(pid, 5_000);
    expect(isProcessAlive(pid)).toBe(false);
  });

  it('terminateProcess tolerates an already-dead pid', async () => {
    home = useTempHome();
    await expect(terminateProcess(getDeadPid(), 1_000)).resolves.toBeUndefined();
  });
});
