import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolvePaths } from '../lib/paths.js';

type LogSource = 'kernel' | 'scribe';

const SOURCES: readonly LogSource[] = ['kernel', 'scribe'];

function tailFile(path: string, count: number): string[] {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  // A trailing newline leaves a final empty element; drop it before tailing.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-count);
}

/**
 * `previously logs` — print the tail of the kernel and scribe logs, one
 * section per source. `-s/--source kernel|scribe` narrows to a single
 * source; `-n/--lines` (default 100) caps each tail.
 */
export async function run(args: string[]): Promise<number> {
  let values: { lines: string; source?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        lines: { type: 'string', short: 'n', default: '100' },
        source: { type: 'string', short: 's' },
      },
    }));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 2;
  }

  const count = Number.parseInt(values.lines, 10);
  if (!Number.isInteger(count) || count <= 0) {
    console.error(`Invalid --lines value: ${values.lines}`);
    return 2;
  }

  let sources: readonly LogSource[] = SOURCES;
  if (values.source !== undefined) {
    if (!(SOURCES as readonly string[]).includes(values.source)) {
      console.error(`Invalid --source value: ${values.source} (expected ${SOURCES.join('|')})`);
      return 2;
    }
    sources = [values.source as LogSource];
  }

  const paths = resolvePaths();
  const logPath: Record<LogSource, string> = {
    kernel: paths.kernelLogPath,
    scribe: paths.scribeLogPath,
  };
  const existing = sources.filter((s) => existsSync(logPath[s]));

  if (existing.length === 0) {
    const details = sources.map((s) => `no ${s} log at ${logPath[s]}`).join('; ');
    // Capitalize the first fragment so the historical "No kernel log …"
    // message shape (and its honest guidance) is preserved.
    console.error(`${details.replace(/^no/, 'No')} — has Previously been started?`);
    return 1;
  }

  const chunks: string[] = [];
  for (const source of sources) {
    chunks.push(`==> ${source}: ${logPath[source]} <==`);
    if (existsSync(logPath[source])) {
      chunks.push(tailFile(logPath[source], count).join('\n'));
    } else {
      chunks.push(`(no ${source} log yet — nothing written to ${logPath[source]})`);
    }
  }
  process.stdout.write(chunks.join('\n\n') + '\n');
  return 0;
}
