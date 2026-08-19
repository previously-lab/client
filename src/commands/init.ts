import { existsSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { defaultConfig, saveConfig } from '../lib/config.js';
import { resolvePaths } from '../lib/paths.js';
import { BRIDGE_AGENTS } from '../bridge/types.js';

const BACKEND_CHOICES = [...BRIDGE_AGENTS, 'api-key', 'none'] as const;
type BackendChoice = (typeof BACKEND_CHOICES)[number];

function normalizeBackend(value: string): BackendChoice | null {
  const v = value.trim().toLowerCase();
  return (BACKEND_CHOICES as readonly string[]).includes(v) ? (v as BackendChoice) : null;
}

/**
 * Resolve the execution backend: --backend flag wins; on an interactive TTY
 * ask once; otherwise stay non-interactive-friendly and leave it unset.
 * 'none' is the explicit opt-out (stored as null).
 */
async function resolveBackend(flag: string | undefined): Promise<string | null> {
  if (flag !== undefined) {
    const choice = normalizeBackend(flag);
    if (choice === null) {
      throw new Error(`Unknown --backend value: ${flag} (expected ${BACKEND_CHOICES.join('|')})`);
    }
    return choice === 'none' ? null : choice;
  }
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Execution backend [${BACKEND_CHOICES.join('/')}] (subscription bridge CLI, or api-key): `,
    );
    const choice = normalizeBackend(answer);
    if (choice === null) {
      console.log(`Unrecognized choice "${answer.trim()}" — leaving executionBackend unset.`);
      return null;
    }
    return choice === 'none' ? null : choice;
  } finally {
    rl.close();
  }
}

/**
 * `previously init` — bootstrap the ~/.previously layout and write a default
 * config.json. Idempotent: an existing config is never overwritten unless
 * --force is passed. `--backend claude|codex|kimi|api-key|none` sets the
 * execution backend non-interactively.
 */
export async function run(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      force: { type: 'boolean', default: false },
      backend: { type: 'string' },
    },
  });

  const paths = resolvePaths();
  for (const dir of [
    paths.home,
    paths.memoryDir,
    paths.kernelDir,
    paths.kernelVersionsDir,
    paths.logsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  if (existsSync(paths.configPath) && !values.force) {
    console.log(`Previously is already initialized at ${paths.home}`);
    console.log(`Existing config kept: ${paths.configPath} (use --force to overwrite)`);
    return 0;
  }

  let backend: string | null;
  try {
    backend = await resolveBackend(values.backend);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
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
