import { existsSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { BRIDGE_AGENTS } from '../bridge/types.js';
import { defaultConfig, saveConfig } from '../lib/config.js';
import { resolvePaths, type PreviouslyPaths } from '../lib/paths.js';

/**
 * `previously init` — non-interactive first-run setup: create the
 * ~/.previously layout and write a minimal default config.json. No prompts
 * (all interactive UX lives in the kernel's Web UI); flags only, so scripts
 * and CI can call it safely.
 */

const BACKEND_CHOICES = [...BRIDGE_AGENTS, 'api-key', 'none'] as const;
type BackendChoice = (typeof BACKEND_CHOICES)[number];

function normalizeBackend(value: string): BackendChoice | null {
  const v = value.trim().toLowerCase();
  return (BACKEND_CHOICES as readonly string[]).includes(v) ? (v as BackendChoice) : null;
}

function ensureLayout(paths: PreviouslyPaths): void {
  for (const dir of [
    paths.home,
    paths.memoryDir,
    paths.kernelDir,
    paths.kernelVersionsDir,
    paths.logsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

export async function run(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      force: { type: 'boolean', default: false },
      backend: { type: 'string' },
    },
  });

  const paths = resolvePaths();

  let backend: string | null = null;
  if (values.backend !== undefined) {
    const choice = normalizeBackend(values.backend);
    if (choice === null) {
      console.error(`Unknown --backend value: ${values.backend} (expected ${BACKEND_CHOICES.join('|')})`);
      return 1;
    }
    backend = choice === 'none' ? null : choice;
  }

  ensureLayout(paths);

  if (existsSync(paths.configPath) && !values.force) {
    console.log(`Previously is already initialized at ${paths.home}`);
    console.log(`Existing config kept: ${paths.configPath} (use --force to overwrite)`);
    return 0;
  }

  const config = defaultConfig(paths);
  config.executionBackend = backend;
  saveConfig(config, paths);
  console.log(`Initialized Previously home at ${paths.home}`);
  console.log(`  memory/          local time-slice storage`);
  console.log(`  kernel/versions/ installed kernel versions (see \`previously kernel install\`)`);
  console.log(`  logs/            kernel logs`);
  console.log(`  config.json      written (execution backend: ${backend ?? '(unset)'})`);
  return 0;
}
