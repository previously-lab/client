import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rotateLogIfOversize } from '../src/lib/log-rotate.js';
import { cleanupTempHome, useTempHome } from './helpers.js';

/** Size-capped log rotation: >cap → .1 rename, keep 3 backups. */
describe('log rotation', () => {
  let home: string;
  afterEach(() => cleanupTempHome(home));

  it('leaves a small log untouched', () => {
    home = useTempHome();
    const log = join(home, 'kernel.log');
    writeFileSync(log, 'short log\n', 'utf8');
    expect(rotateLogIfOversize(log, 1024)).toBe(false);
    expect(readFileSync(log, 'utf8')).toBe('short log\n');
    expect(existsSync(`${log}.1`)).toBe(false);
  });

  it('rotates an oversize log and shifts existing backups', () => {
    home = useTempHome();
    const log = join(home, 'kernel.log');
    writeFileSync(`${log}.1`, 'backup-one', 'utf8');
    writeFileSync(`${log}.2`, 'backup-two', 'utf8');
    writeFileSync(log, 'x'.repeat(2048), 'utf8');

    expect(rotateLogIfOversize(log, 1024, 3)).toBe(true);
    expect(existsSync(log)).toBe(false);
    expect(readFileSync(`${log}.1`, 'utf8')).toBe('x'.repeat(2048));
    expect(readFileSync(`${log}.2`, 'utf8')).toBe('backup-one');
    expect(readFileSync(`${log}.3`, 'utf8')).toBe('backup-two');
  });

  it('drops the oldest backup beyond the keep count', () => {
    home = useTempHome();
    const log = join(home, 'scribe.log');
    writeFileSync(`${log}.1`, 'one', 'utf8');
    writeFileSync(`${log}.2`, 'two', 'utf8');
    writeFileSync(`${log}.3`, 'three', 'utf8');
    writeFileSync(log, 'y'.repeat(2048), 'utf8');

    expect(rotateLogIfOversize(log, 1024, 3)).toBe(true);
    expect(readFileSync(`${log}.1`, 'utf8')).toBe('y'.repeat(2048));
    expect(readFileSync(`${log}.2`, 'utf8')).toBe('one');
    expect(readFileSync(`${log}.3`, 'utf8')).toBe('two');
  });

  it('is a no-op for a missing log', () => {
    home = useTempHome();
    expect(rotateLogIfOversize(join(home, 'nope.log'))).toBe(false);
  });
});
