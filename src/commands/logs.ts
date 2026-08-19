import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolvePaths } from '../lib/paths.js';

/**
 * `previously logs` — print the tail of the kernel log file.
 */
export async function run(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      lines: { type: 'string', short: 'n', default: '100' },
    },
  });

  const paths = resolvePaths();
  if (!existsSync(paths.kernelLogPath)) {
    console.error(`No kernel log at ${paths.kernelLogPath} — has the kernel been started?`);
    return 1;
  }

  const count = Number.parseInt(values.lines, 10);
  if (!Number.isInteger(count) || count <= 0) {
    console.error(`Invalid --lines value: ${values.lines}`);
    return 1;
  }

  const lines = readFileSync(paths.kernelLogPath, 'utf8').split(/\r?\n/);
  // A trailing newline leaves a final empty element; drop it before tailing.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  process.stdout.write(lines.slice(-count).join('\n') + '\n');
  return 0;
}
