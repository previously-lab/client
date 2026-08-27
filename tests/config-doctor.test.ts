import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, type PreviouslyConfig } from '../src/lib/config.js';
import { applyAudit, applyBackend, auditConfig, auditMemoryRepo, isBridgeAgent, repairConfig } from '../src/lib/config-doctor.js';
import { ensureMemoryRepo, repoSummary } from '../src/lib/memory-repo.js';
import { resolvePaths } from '../src/lib/paths.js';
import { cleanupTempHome, useTempHome, writeFixtureMemory } from './helpers.js';

/**
 * The config doctor runs fully sandboxed: PREVIOUSLY_HOME points at a temp
 * dir, raw configs are hand-written JSON files (including illegal values no
 * TypeScript type would allow — that is exactly what the doctor exists for).
 */

describe('config doctor', () => {
  let home: string;
  afterEach(() => cleanupTempHome(home));

  /** Write a raw (possibly illegal) config.json into the temp home. */
  function writeRawConfig(raw: unknown): void {
    const paths = resolvePaths();
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.configPath, JSON.stringify(raw), 'utf8');
  }

  function readConfig(): PreviouslyConfig {
    return JSON.parse(readFileSync(resolvePaths().configPath, 'utf8')) as PreviouslyConfig;
  }

  it('isBridgeAgent recognizes exactly the three bridge CLIs', () => {
    expect(isBridgeAgent('claude')).toBe(true);
    expect(isBridgeAgent('codex')).toBe(true);
    expect(isBridgeAgent('kimi')).toBe(true);
    expect(isBridgeAgent('gemini')).toBe(false);
    expect(isBridgeAgent('api-key')).toBe(false);
  });

  it('applyBackend derives a bridge brain; api-key/none leave brain alone', () => {
    const paths = resolvePaths();
    const config = defaultConfig(paths);
    applyBackend(config, 'kimi');
    expect(config.executionBackend).toBe('kimi');
    expect(config.brain).toEqual({ type: 'bridge', agent: 'kimi' });

    const apiKey = defaultConfig(paths);
    applyBackend(apiKey, 'api-key');
    expect(apiKey.executionBackend).toBe('api-key');
    expect(apiKey.brain).toBeUndefined();

    const none = defaultConfig(paths);
    applyBackend(none, null);
    expect(none.executionBackend).toBeNull();
    expect(none.brain).toBeUndefined();
  });

  it('a missing config.json audits as healthy defaults with no repairs', () => {
    home = useTempHome();
    const audit = auditConfig(resolvePaths());
    expect(audit.repairs).toEqual([]);
    expect(audit.config).toEqual(defaultConfig(resolvePaths()));
  });

  it('a healthy config yields zero repairs', () => {
    home = useTempHome();
    writeRawConfig({ ...defaultConfig(resolvePaths()), executionBackend: 'claude', brain: { type: 'bridge', agent: 'claude' } });
    expect(auditConfig(resolvePaths()).repairs).toEqual([]);
  });

  it('resets an unsupported storage value to "local"', () => {
    home = useTempHome();
    writeRawConfig({ storage: 'remote' });
    const audit = auditConfig(resolvePaths());
    expect(audit.config.storage).toBe('local');
    expect(audit.repairs.join('\n')).toContain('storage "remote" is unsupported');
  });

  it('resets an empty memoryRoot to the default', () => {
    home = useTempHome();
    writeRawConfig({ memoryRoot: '   ' });
    const audit = auditConfig(resolvePaths());
    expect(audit.config.memoryRoot).toBe(resolvePaths().memoryDir);
    expect(audit.repairs.join('\n')).toContain('memoryRoot missing/empty');
  });

  it('resets invalid ports (out of range / non-integer) to 3210', () => {
    home = useTempHome();
    for (const bad of [0, 70000, 3.14, 'abc']) {
      writeRawConfig({ port: bad });
      const audit = auditConfig(resolvePaths());
      expect(audit.config.port).toBe(3210);
      expect(audit.repairs.join('\n')).toContain('port');
    }
    // Boundary values are legal.
    writeRawConfig({ port: 1 });
    expect(auditConfig(resolvePaths()).repairs).toEqual([]);
    writeRawConfig({ port: 65535 });
    expect(auditConfig(resolvePaths()).repairs).toEqual([]);
  });

  it('resets an empty hostname to 127.0.0.1', () => {
    home = useTempHome();
    writeRawConfig({ hostname: '' });
    const audit = auditConfig(resolvePaths());
    expect(audit.config.hostname).toBe('127.0.0.1');
    expect(audit.repairs.join('\n')).toContain('hostname missing/empty');
  });

  it('resets an unknown executionBackend to unset', () => {
    home = useTempHome();
    writeRawConfig({ executionBackend: 'gemini' });
    const audit = auditConfig(resolvePaths());
    expect(audit.config.executionBackend).toBeNull();
    expect(audit.repairs.join('\n')).toContain('executionBackend "gemini" is unknown');
  });

  it('backfills brain when the backend is a bridge agent and brain is missing', () => {
    home = useTempHome();
    writeRawConfig({ executionBackend: 'claude' });
    const audit = auditConfig(resolvePaths());
    expect(audit.config.brain).toEqual({ type: 'bridge', agent: 'claude' });
    expect(audit.repairs.join('\n')).toContain('brain missing while backend is "claude"');
  });

  it('removes malformed brains (bad type / bad agent / empty env)', () => {
    home = useTempHome();
    const malformed = [
      { type: 'magic' },
      { type: 'bridge', agent: 'gemini' },
      { type: 'api-key', env: '  ' },
    ];
    for (const brain of malformed) {
      // backend null: nothing to re-derive from, so removal is the whole repair.
      writeRawConfig({ brain });
      const audit = auditConfig(resolvePaths());
      expect(audit.config.brain).toBeUndefined();
      expect(audit.repairs).toEqual(['brain is malformed — removed (re-derive from backend below when possible)']);
    }
  });

  it('a malformed brain under a bridge backend is removed and re-derived', () => {
    home = useTempHome();
    writeRawConfig({ executionBackend: 'codex', brain: { type: 'bridge', agent: 'gemini' } });
    const audit = auditConfig(resolvePaths());
    expect(audit.config.brain).toEqual({ type: 'bridge', agent: 'codex' });
    expect(audit.repairs).toHaveLength(2);
    expect(audit.repairs[0]).toContain('malformed');
    expect(audit.repairs[1]).toContain('brain missing while backend is "codex"');
  });

  it('keeps a valid api-key brain untouched', () => {
    home = useTempHome();
    writeRawConfig({ executionBackend: 'api-key', brain: { type: 'api-key', env: 'DEEPSEEK_API_KEY' } });
    expect(auditConfig(resolvePaths()).repairs).toEqual([]);
  });

  it('removes a non-string kernelDir', () => {
    home = useTempHome();
    writeRawConfig({ kernelDir: 123 });
    const audit = auditConfig(resolvePaths());
    expect(audit.config.kernelDir).toBeUndefined();
    expect(audit.repairs.join('\n')).toContain('kernelDir is not a usable path');
  });

  it('removes a non-object apiKeys', () => {
    home = useTempHome();
    writeRawConfig({ apiKeys: ['not', 'an', 'object'] });
    const audit = auditConfig(resolvePaths());
    expect(audit.config.apiKeys).toBeUndefined();
    expect(audit.repairs.join('\n')).toContain('apiKeys is not an object');
  });

  it('drops unknown keys from agents but keeps bridge-agent entries', () => {
    home = useTempHome();
    writeRawConfig({ agents: { claude: { model: 'opus' }, gemini: { model: 'x' } } });
    const audit = auditConfig(resolvePaths());
    expect(audit.config.agents).toEqual({ claude: { model: 'opus' } });
    expect(audit.repairs.join('\n')).toContain('agents.gemini is not a known bridge agent');
  });

  it('removes a non-object agents field entirely', () => {
    home = useTempHome();
    writeRawConfig({ agents: 'claude' });
    const audit = auditConfig(resolvePaths());
    expect(audit.config.agents).toBeUndefined();
    expect(audit.repairs.join('\n')).toContain('agents is not an object');
  });

  it('corrupt JSON falls back to defaults with one repair note', () => {
    home = useTempHome();
    const paths = resolvePaths();
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.configPath, '{ not json !!!', 'utf8');
    const audit = auditConfig(paths);
    expect(audit.config).toEqual(defaultConfig(paths));
    expect(audit.repairs).toHaveLength(1);
    expect(audit.repairs[0]).toContain('not valid JSON');
  });

  it('repairConfig does not mutate its input', () => {
    home = useTempHome();
    const raw = { ...defaultConfig(resolvePaths()), port: 70000 };
    repairConfig(raw, resolvePaths());
    expect(raw.port).toBe(70000);
  });

  it('is idempotent: auditing a repaired config yields no further repairs', () => {
    home = useTempHome();
    writeRawConfig({
      storage: 'remote',
      port: 70000,
      executionBackend: 'claude',
      agents: { gemini: {} },
    });
    const paths = resolvePaths();
    const first = auditConfig(paths);
    expect(first.repairs.length).toBeGreaterThan(0);
    applyAudit(paths, first);
    const second = auditConfig(paths);
    expect(second.repairs).toEqual([]);
    expect(second.config).toEqual(first.config);
  });

  it('applyAudit backs up the original to config.json.bak, then writes the repair', () => {
    home = useTempHome();
    const paths = resolvePaths();
    writeRawConfig({ executionBackend: 'claude' });
    const original = readFileSync(paths.configPath, 'utf8');

    applyAudit(paths, auditConfig(paths));
    // The .bak preserves the broken bytes exactly.
    expect(readFileSync(`${paths.configPath}.bak`, 'utf8')).toBe(original);
    const repaired = readConfig();
    expect(repaired.brain).toEqual({ type: 'bridge', agent: 'claude' });
  });

  it('a second repair keeps the original .bak instead of clobbering it', () => {
    home = useTempHome();
    const paths = resolvePaths();
    writeRawConfig({ port: 'abc', note: 'ORIGINAL' });
    const original = readFileSync(paths.configPath, 'utf8');

    applyAudit(paths, auditConfig(paths));
    expect(readFileSync(`${paths.configPath}.bak`, 'utf8')).toBe(original);

    // Corrupt the config again and repair again — the .bak must still hold
    // the FIRST pre-repair state, not the damaged intermediate.
    writeRawConfig({ port: 'xyz', note: 'CORRUPT-V2' });
    applyAudit(paths, auditConfig(paths));
    expect(readFileSync(`${paths.configPath}.bak`, 'utf8')).toBe(original);
    expect(readConfig().port).toBe(3210);
  });

  it('a byok section survives repairs and suppresses bridge-brain re-derivation', () => {
    home = useTempHome();
    const paths = resolvePaths();
    // The Web UI BYOK engine deliberately clears brain; the doctor must not
    // resurrect a bridge brain from the backend on the next `start`.
    writeRawConfig({
      executionBackend: 'kimi',
      byok: { provider: 'deepseek', apiKey: 'sk-x', model: 'deepseek-chat' },
    });

    const audit = auditConfig(paths);
    expect(audit.repairs).toEqual([]);
    applyAudit(paths, audit);
    const config = readConfig() as PreviouslyConfig & { byok?: unknown };
    expect(config.brain).toBeUndefined();
    expect(config.byok).toEqual({ provider: 'deepseek', apiKey: 'sk-x', model: 'deepseek-chat' });
  });

  it('applyAudit on a healthy config is a no-op (no .bak, bytes untouched)', () => {
    home = useTempHome();
    const paths = resolvePaths();
    writeRawConfig(defaultConfig(paths));
    const before = readFileSync(paths.configPath, 'utf8');

    applyAudit(paths, auditConfig(paths));
    expect(existsSync(`${paths.configPath}.bak`)).toBe(false);
    expect(readFileSync(paths.configPath, 'utf8')).toBe(before);
  });
});

describe('memory repo doctor', () => {
  let home: string;
  afterEach(() => cleanupTempHome(home));

  it('recreates a missing memory root as a git repository', async () => {
    home = useTempHome();
    const memoryRoot = join(home, 'memory');
    const audit = await auditMemoryRepo(memoryRoot);
    expect(audit.repairs.join('\n')).toContain('recreated as a git repository');
    expect(audit.warnings).toEqual([]);
    expect(existsSync(join(memoryRoot, '.git'))).toBe(true);
    expect(existsSync(join(memoryRoot, 'README.md'))).toBe(true);
  });

  it('initializes git in place when Previously content exists without .git (content committed)', async () => {
    home = useTempHome();
    const memoryRoot = join(home, 'memory');
    writeFixtureMemory(home);
    const audit = await auditMemoryRepo(memoryRoot);
    expect(audit.repairs.join('\n')).toContain('initialized a git repository in place');
    expect(audit.warnings).toEqual([]);
    expect(existsSync(join(memoryRoot, '.git'))).toBe(true);
    // The pre-existing content was committed, not left dangling.
    const summary = await repoSummary(memoryRoot);
    expect(summary?.uncommitted).toBe(0);
    expect(summary?.lastCommitAt).not.toBeNull();
  });

  it('only warns on a foreign non-empty non-git directory and never touches it', async () => {
    home = useTempHome();
    const memoryRoot = join(home, 'memory');
    mkdirSync(memoryRoot, { recursive: true });
    writeFileSync(join(memoryRoot, 'precious.txt'), 'do not touch\n', 'utf8');
    const audit = await auditMemoryRepo(memoryRoot);
    expect(audit.repairs).toEqual([]);
    expect(audit.warnings.join('\n')).toContain('not a git repository');
    expect(existsSync(join(memoryRoot, '.git'))).toBe(false);
  });

  it('leaves a healthy git repository alone', async () => {
    home = useTempHome();
    const memoryRoot = join(home, 'memory');
    await ensureMemoryRepo(memoryRoot);
    const audit = await auditMemoryRepo(memoryRoot);
    expect(audit.repairs).toEqual([]);
    expect(audit.warnings).toEqual([]);
  });
});
