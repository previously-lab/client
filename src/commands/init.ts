import { existsSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { defaultConfig, saveConfig } from '../lib/config.js';
import { resolvePaths } from '../lib/paths.js';

/**
 * `previously init` — bootstrap the ~/.previously layout and write a default
 * config.json. Idempotent: an existing config is never overwritten unless
 * --force is passed.
 */
export async function run(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { force: { type: 'boolean', default: false } },
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

  saveConfig(defaultConfig(paths), paths);
  console.log(`Initialized Previously home at ${paths.home}`);
  console.log(`  memory/          local time-slice storage`);
  console.log(`  kernel/versions/ installed kernel versions (see \`previously kernel install\`)`);
  console.log(`  logs/            kernel logs`);
  console.log(`  config.json      written with defaults`);
  return 0;
}
