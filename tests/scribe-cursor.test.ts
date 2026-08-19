import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chainHash, CursorStore, EMPTY_HASH } from '../src/scribe/cursor.js';
import { cleanupTempHome, useTempHome } from './helpers.js';

describe('scribe cursor store', () => {
  let home: string;
  afterEach(() => cleanupTempHome(home));

  it('save/load round-trips cursors', () => {
    home = useTempHome();
    const path = join(home, 'scribe', 'cursors.json');
    const store = new CursorStore(path);
    store.set('/fake/session.jsonl', {
      source: 'claude-code',
      offset: 1234,
      lines: 10,
      hash: chainHash(EMPTY_HASH, Buffer.from('chunk')),
      parserVersion: 1,
      updatedAt: new Date().toISOString(),
    });
    store.save();

    const reloaded = new CursorStore(path);
    expect(reloaded.load()).toBeNull();
    const cursor = reloaded.get('/fake/session.jsonl');
    expect(cursor).not.toBeNull();
    expect(cursor!.offset).toBe(1234);
    expect(cursor!.lines).toBe(10);
    expect(cursor!.parserVersion).toBe(1);
    expect(cursor!.source).toBe('claude-code');
  });

  it('writes atomically (no leftover temp files)', () => {
    home = useTempHome();
    const path = join(home, 'scribe', 'cursors.json');
    const store = new CursorStore(path);
    store.save();
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
  });

  it('quarantines a corrupt cursors.json instead of crashing', () => {
    home = useTempHome();
    const path = join(home, 'scribe', 'cursors.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json', 'utf8');
    const store = new CursorStore(path);
    const note = store.load();
    expect(note).toContain('quarantined');
    expect(existsSync(`${path}.corrupt`)).toBe(true);
    expect(readFileSync(`${path}.corrupt`, 'utf8')).toBe('{ not json');
    expect(store.files()).toEqual([]);
  });

  it('chainHash is deterministic and order-sensitive', () => {
    const a = chainHash(chainHash(EMPTY_HASH, Buffer.from('one')), Buffer.from('two'));
    const b = chainHash(chainHash(EMPTY_HASH, Buffer.from('one')), Buffer.from('two'));
    const c = chainHash(chainHash(EMPTY_HASH, Buffer.from('two')), Buffer.from('one'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
