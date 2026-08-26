import { describe, expect, it } from 'vitest';
import { defaultConfig, type PreviouslyConfig } from '../src/lib/config.js';
import { buildKernelEnv } from '../src/lib/kernel-env.js';
import type { PreviouslyPaths } from '../src/lib/paths.js';

const paths = { home: '/home/x/.previously' } as PreviouslyPaths;

function config(overrides: Partial<PreviouslyConfig> = {}): PreviouslyConfig {
  return {
    storage: 'local',
    memoryRoot: '/home/x/.previously/memory',
    port: 3210,
    hostname: '127.0.0.1',
    executionBackend: null,
    ...overrides,
  };
}

describe('buildKernelEnv (start env contract)', () => {
  it('carries the established keys plus PREVIOUSLY_HOME', () => {
    const env = buildKernelEnv(config(), paths, {});
    expect(env).toMatchObject({
      PREVIOUSLY_HOME: '/home/x/.previously',
      PREVIOUSLY_MODE: 'client',
      STORAGE: 'local',
      MEMORY_ROOT: '/home/x/.previously/memory',
      WORKFLOW_TARGET_WORLD: 'local',
      PORT: '3210',
      HOSTNAME: '127.0.0.1',
    });
    expect(env.PREVIOUSLY_BRAIN).toBeUndefined();
    expect(env.PREVIOUSLY_BRAIN_AGENT).toBeUndefined();
    expect(env.PREVIOUSLY_DEFAULT_MODEL).toBeUndefined();
  });

  it('injects PREVIOUSLY_BRIDGE_CMD as the registered command name', () => {
    // The client is an installed application: the kernel and bridged agents
    // invoke it the same way the user does — never an absolute path into a
    // checkout's build output.
    const cmd = buildKernelEnv(config(), paths, {}).PREVIOUSLY_BRIDGE_CMD;
    expect(cmd).toBe('previously bridge-exec');
  });

  it('injects every config.apiKeys entry', () => {
    const env = buildKernelEnv(config({ apiKeys: { DEEPSEEK_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-b' } }), paths, {});
    expect(env.DEEPSEEK_API_KEY).toBe('sk-a');
    expect(env.OPENAI_API_KEY).toBe('sk-b');
  });

  it('bridge brain sets PREVIOUSLY_BRAIN and PREVIOUSLY_BRAIN_AGENT', () => {
    const env = buildKernelEnv(config({ brain: { type: 'bridge', agent: 'kimi' } }), paths, {});
    expect(env.PREVIOUSLY_BRAIN).toBe('bridge');
    expect(env.PREVIOUSLY_BRAIN_AGENT).toBe('kimi');
  });

  it('api-key brain passes the key from apiKeys and forwards the model', () => {
    const env = buildKernelEnv(
      config({
        brain: { type: 'api-key', env: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' },
        apiKeys: { DEEPSEEK_API_KEY: 'sk-real' },
      }),
      paths,
      {},
    );
    expect(env.DEEPSEEK_API_KEY).toBe('sk-real');
    expect(env.PREVIOUSLY_DEFAULT_MODEL).toBe('deepseek-chat');
    expect(env.PREVIOUSLY_BRAIN).toBeUndefined();
  });

  it('api-key brain falls back to the process env for the key value', () => {
    const env = buildKernelEnv(
      config({ brain: { type: 'api-key', env: 'ANTHROPIC_API_KEY' } }),
      paths,
      { ANTHROPIC_API_KEY: 'sk-from-env' },
    );
    expect(env.ANTHROPIC_API_KEY).toBe('sk-from-env');
  });

  it('api-key brain without any available key adds nothing extra', () => {
    const env = buildKernelEnv(config({ brain: { type: 'api-key', env: 'OPENAI_API_KEY' } }), paths, {});
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PREVIOUSLY_DEFAULT_MODEL).toBeUndefined();
  });

  it('defaultConfig carries no brain/apiKeys (backward compatible)', () => {
    const d = defaultConfig(paths);
    expect(d.brain).toBeUndefined();
    expect(d.apiKeys).toBeUndefined();
  });
});
