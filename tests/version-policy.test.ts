import { describe, expect, it } from 'vitest';
import {
  checkCompat,
  formatSemver,
  getPinnedKernelVersion,
  parseKernelVersionFromSource,
  parseSemver,
} from '../src/lib/version-policy.js';

describe('parseSemver', () => {
  it('parses strict x.y.z, with or without a v prefix', () => {
    expect(parseSemver('0.9.0')).toEqual({ major: 0, minor: 9, patch: 0 });
    expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver(' 10.20.30 ')).toEqual({ major: 10, minor: 20, patch: 30 });
  });

  it('rejects anything else', () => {
    for (const bad of ['0.9', '0.9.0-beta.1', 'x.y.z', 'v0.9', '', '0.9.0.1']) {
      expect(parseSemver(bad), bad).toBeNull();
    }
  });

  it('formats', () => {
    expect(formatSemver(parseSemver('v0.9.2')!)).toBe('0.9.2');
  });
});

describe('getPinnedKernelVersion', () => {
  it('reads previously.kernelVersion from package.json', () => {
    expect(getPinnedKernelVersion()).toBe('0.9.0');
  });
});

describe('checkCompat (exact pin)', () => {
  it('accepts only the exact pinned version', () => {
    expect(checkCompat('0.9.0', '0.9.0').ok).toBe(true);
  });

  it('refuses even a patch-level drift', () => {
    const res = checkCompat('0.9.1', '0.9.0');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('0.9.1');
    expect(res.message).toContain('0.9.0');
  });

  it('refuses a newer minor with the upgrade-client message', () => {
    const res = checkCompat('0.10.0', '0.9.0');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('0.10.0');
    expect(res.message).toContain('npm i -g @previously-lab/client@latest');
    expect(res.message).not.toContain('previously upgrade');
  });

  it('refuses an older version too', () => {
    const res = checkCompat('0.8.3', '0.9.0');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('0.8.3');
  });

  it('refuses unparseable versions honestly', () => {
    const res = checkCompat('not-a-version', '0.9.0');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('Unparseable kernel version');
  });

  it('defaults to the package.json pin', () => {
    expect(checkCompat('0.9.0').ok).toBe(true);
    expect(checkCompat('0.8.0').ok).toBe(false);
  });
});

describe('parseKernelVersionFromSource', () => {
  it('parses the version constant from src/lib/version/constants.ts', () => {
    expect(
      parseKernelVersionFromSource(
        `/** Real kernel version. package.json is stale — do not read it. */\nexport const PREVIOUSLY_VERSION = '0.9.0';\n`,
      ),
    ).toBe('0.9.0');
  });

  it('does not depend on the constant name or quote style', () => {
    expect(parseKernelVersionFromSource(`export const VERSION = "1.2.3";`)).toBe('1.2.3');
    expect(parseKernelVersionFromSource(`export default 'v0.9.1';`)).toBe('0.9.1');
  });

  it('returns null when no version literal is present', () => {
    expect(parseKernelVersionFromSource(`export const FOO = 'bar';`)).toBeNull();
  });
});
