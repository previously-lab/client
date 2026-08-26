import { afterEach, describe, expect, it } from 'vitest';
import {
  assertReaderAllowed,
  isReaderCommandAllowed,
  READER_SCOPE_ENV,
  resolveReaderScope,
} from '../src/lib/reader-scope.js';

const ALL_READERS = ['readslice', 'timeline', 'strands', 'card', 'slicesummary', 'agentlog'];
const HOUSEKEEPING_READERS = ['readslice', 'agentlog', 'card'];
const HOUSEKEEPING_DENIED = ['timeline', 'strands', 'slicesummary'];

describe('resolveReaderScope', () => {
  it('unset / empty / whitespace means no gate', () => {
    expect(resolveReaderScope(undefined)).toBeNull();
    expect(resolveReaderScope('')).toBeNull();
    expect(resolveReaderScope('   ')).toBeNull();
  });

  it("'chat' and 'housekeeping' map to themselves", () => {
    expect(resolveReaderScope('chat')).toBe('chat');
    expect(resolveReaderScope('housekeeping')).toBe('housekeeping');
  });

  it('unknown non-empty values degrade to the strictest scope', () => {
    expect(resolveReaderScope('deep-think')).toBe('housekeeping');
    expect(resolveReaderScope('CHAT')).toBe('housekeeping');
  });
});

describe('isReaderCommandAllowed', () => {
  it('no scope: everything allowed, including card bootstrap', () => {
    for (const cmd of [...ALL_READERS, 'card bootstrap']) {
      expect(isReaderCommandAllowed(cmd, null)).toBe(true);
    }
  });

  it('chat: all six reader commands allowed', () => {
    for (const cmd of ALL_READERS) {
      expect(isReaderCommandAllowed(cmd, 'chat')).toBe(true);
    }
  });

  it('chat: card bootstrap refused (token-spending init, never a bridge call)', () => {
    expect(isReaderCommandAllowed('card bootstrap', 'chat')).toBe(false);
  });

  it('housekeeping: only readslice / agentlog / card allowed', () => {
    for (const cmd of HOUSEKEEPING_READERS) {
      expect(isReaderCommandAllowed(cmd, 'housekeeping')).toBe(true);
    }
    for (const cmd of HOUSEKEEPING_DENIED) {
      expect(isReaderCommandAllowed(cmd, 'housekeeping')).toBe(false);
    }
  });

  it('housekeeping: card bootstrap refused', () => {
    expect(isReaderCommandAllowed('card bootstrap', 'housekeeping')).toBe(false);
  });
});

describe('assertReaderAllowed (env wrapper)', () => {
  afterEach(() => {
    delete process.env[READER_SCOPE_ENV];
  });

  it('returns null for everything when the env is unset', () => {
    delete process.env[READER_SCOPE_ENV];
    for (const cmd of [...ALL_READERS, 'card bootstrap']) {
      expect(assertReaderAllowed(cmd)).toBeNull();
    }
  });

  it('chat scope allows the six readers and refuses card bootstrap', () => {
    process.env[READER_SCOPE_ENV] = 'chat';
    for (const cmd of ALL_READERS) {
      expect(assertReaderAllowed(cmd)).toBeNull();
    }
    expect(assertReaderAllowed('card bootstrap')).toContain('card bootstrap');
  });

  it('housekeeping scope denies timeline with an honest message naming phase and command', () => {
    process.env[READER_SCOPE_ENV] = 'housekeeping';
    const denial = assertReaderAllowed('timeline');
    expect(denial).not.toBeNull();
    expect(denial).toContain('timeline');
    expect(denial).toContain('housekeeping');
    expect(denial).toContain(READER_SCOPE_ENV);
    expect(assertReaderAllowed('readslice')).toBeNull();
    expect(assertReaderAllowed('agentlog')).toBeNull();
    expect(assertReaderAllowed('card')).toBeNull();
  });

  it('an unknown scope value is treated as housekeeping', () => {
    process.env[READER_SCOPE_ENV] = 'whatever';
    expect(assertReaderAllowed('strands')).not.toBeNull();
    expect(assertReaderAllowed('readslice')).toBeNull();
  });

  it('the bootstrap denial says why and how to run it legitimately', () => {
    process.env[READER_SCOPE_ENV] = 'housekeeping';
    const denial = assertReaderAllowed('card bootstrap');
    expect(denial).toContain('spends tokens');
    expect(denial).toContain('no scope set');
  });
});
