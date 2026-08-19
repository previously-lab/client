import { describe, expect, it } from 'vitest';
import {
  checkCompat,
  compareSemver,
  formatSemver,
  getKernelLine,
  parseKernelVersionFromSource,
  parseRemoteTags,
  parseSemver,
  selectUpgradeTarget,
  versionLine,
  type RemoteTag,
} from '../src/lib/version-policy.js';

describe('parseSemver', () => {
  it('parses strict x.y.z, with or without a v prefix', () => {
    expect(parseSemver('0.8.0')).toEqual({ major: 0, minor: 8, patch: 0 });
    expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver(' 10.20.30 ')).toEqual({ major: 10, minor: 20, patch: 30 });
  });

  it('rejects anything else', () => {
    for (const bad of ['0.8', '0.8.0-beta.1', 'x.y.z', 'v0.8', '', '0.8.0.1']) {
      expect(parseSemver(bad), bad).toBeNull();
    }
  });

  it('compares and formats', () => {
    expect(compareSemver(parseSemver('0.8.1')!, parseSemver('0.8.2')!)).toBeLessThan(0);
    expect(compareSemver(parseSemver('0.9.0')!, parseSemver('0.8.9')!)).toBeGreaterThan(0);
    expect(formatSemver(parseSemver('v0.8.2')!)).toBe('0.8.2');
    expect(versionLine(parseSemver('0.8.2')!)).toBe('0.8');
  });
});

describe('getKernelLine', () => {
  it('reads previously.kernelLine from package.json', () => {
    expect(getKernelLine()).toBe('0.8');
  });
});

describe('checkCompat', () => {
  it('accepts any patch within the same line', () => {
    expect(checkCompat('0.8.0', '0.8').ok).toBe(true);
    expect(checkCompat('0.8.1', '0.8').ok).toBe(true);
    expect(checkCompat('0.8.42', '0.8').ok).toBe(true);
  });

  it('refuses a newer minor with the upgrade-client message', () => {
    const res = checkCompat('0.9.0', '0.8');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('0.9.0');
    expect(res.message).toContain('client >= 0.9');
    expect(res.message).toContain('npm i -g previously-client@latest');
  });

  it('refuses an older minor too', () => {
    const res = checkCompat('0.7.3', '0.8');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('line 0.7.x');
  });

  it('refuses unparseable versions honestly', () => {
    const res = checkCompat('not-a-version', '0.8');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('Unparseable kernel version');
  });
});

describe('parseKernelVersionFromSource', () => {
  it('parses the version constant from src/lib/version/constants.ts', () => {
    expect(
      parseKernelVersionFromSource(
        `/** Real kernel version. package.json is stale — do not read it. */\nexport const PREVIOUSLY_VERSION = '0.8.0';\n`,
      ),
    ).toBe('0.8.0');
  });

  it('does not depend on the constant name or quote style', () => {
    expect(parseKernelVersionFromSource(`export const VERSION = "1.2.3";`)).toBe('1.2.3');
    expect(parseKernelVersionFromSource(`export default 'v0.9.1';`)).toBe('0.9.1');
  });

  it('returns null when no version literal is present', () => {
    expect(parseKernelVersionFromSource(`export const FOO = 'bar';`)).toBeNull();
  });
});

const LS_REMOTE = [
  'aaa111\trefs/tags/v0.7.0',
  'bbb222\trefs/tags/v0.8.0',
  'ccc333\trefs/tags/v0.8.1',
  'ddd444\trefs/tags/v0.8.2',
  'ddd444\trefs/tags/v0.8.2^{}',
  'eee555\trefs/tags/nightly',
  'fff666\trefs/tags/v0.9.0',
].join('\n');

describe('parseRemoteTags', () => {
  it('parses semver tags, skipping peeled ^{} lines and non-semver tags', () => {
    const tags = parseRemoteTags(LS_REMOTE);
    expect(tags.map((t) => formatSemver(t.version)).sort()).toEqual([
      '0.7.0',
      '0.8.0',
      '0.8.1',
      '0.8.2',
      '0.9.0',
    ]);
    expect(tags.find((t) => formatSemver(t.version) === '0.8.2')?.tag).toBe('v0.8.2');
  });

  it('handles empty output', () => {
    expect(parseRemoteTags('')).toEqual([]);
  });
});

function tag(v: string): RemoteTag {
  return { tag: `v${v}`, version: parseSemver(v)! };
}

describe('selectUpgradeTarget', () => {
  it('picks the newest patch within the current line', () => {
    const target = selectUpgradeTarget(
      [tag('0.8.0'), tag('0.8.2'), tag('0.8.1')],
      '0.8',
      '0.8.0',
    );
    expect(target).toEqual({ kind: 'install', release: tag('0.8.2') });
  });

  it('installs when no kernel is installed yet', () => {
    const target = selectUpgradeTarget([tag('0.8.2')], '0.8', null);
    expect(target.kind).toBe('install');
  });

  it('reports up-to-date when the newest in-line tag is already current', () => {
    const target = selectUpgradeTarget([tag('0.8.1'), tag('0.8.2')], '0.8', '0.8.2');
    expect(target.kind).toBe('up-to-date');
  });

  it('refuses when the newest tag has crossed to a new minor', () => {
    const target = selectUpgradeTarget(parseRemoteTags(LS_REMOTE), '0.8', '0.8.2');
    expect(target.kind).toBe('crossed-line');
    if (target.kind === 'crossed-line') {
      expect(target.message).toContain('0.9.0');
      expect(target.message).toContain('npm i -g previously-client@latest');
    }
  });

  it('ignores older-minor tags when deciding', () => {
    const target = selectUpgradeTarget([tag('0.7.9'), tag('0.8.3')], '0.8', '0.8.1');
    expect(target).toEqual({ kind: 'install', release: tag('0.8.3') });
  });

  it('reports no-tags honestly', () => {
    expect(selectUpgradeTarget([], '0.8', null).kind).toBe('no-tags');
  });
});
