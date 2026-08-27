import { afterEach, describe, expect, it } from 'vitest';
import { parseMsEnv } from '../src/lib/env.js';

describe('parseMsEnv', () => {
  const NAME = 'PREVIOUSLY_TEST_PARSE_MS';

  afterEach(() => {
    delete process.env[NAME];
  });

  it('returns the fallback when the env var is unset', () => {
    expect(parseMsEnv(NAME, 30_000)).toBe(30_000);
  });

  it('accepts a positive numeric value', () => {
    process.env[NAME] = '5000';
    expect(parseMsEnv(NAME, 30_000)).toBe(5_000);
  });

  it('rejects garbage instead of leaking NaN', () => {
    process.env[NAME] = 'abc';
    expect(parseMsEnv(NAME, 30_000)).toBe(30_000);
  });

  it('rejects zero and negatives', () => {
    process.env[NAME] = '0';
    expect(parseMsEnv(NAME, 30_000)).toBe(30_000);
    process.env[NAME] = '-100';
    expect(parseMsEnv(NAME, 30_000)).toBe(30_000);
  });
});
