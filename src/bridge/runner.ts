import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { BridgeError, type BridgeAgent, type BridgeTask } from './types.js';

/**
 * Default adapter timeout: just under the kernel's delegateTask default
 * (BRIDGE_DEFAULT_TIMEOUT_MS = 10 min) so the adapter reports its own honest
 * timeout error before the kernel kills the bridge process.
 */
export const BRIDGE_DEFAULT_TIMEOUT_MS = 570_000;

/** Adapter env overrides: PREVIOUSLY_BRIDGE_<AGENT>_CMD / _TIMEOUT_MS, plus the
 *  global PREVIOUSLY_BRIDGE_TIMEOUT_MS (same name the kernel uses). */
function envKey(agent: BridgeAgent, suffix: string): string {
  return `PREVIOUSLY_BRIDGE_${agent.toUpperCase()}_${suffix}`;
}

/** Whitespace split with simple double/single-quote grouping (same convention
 *  as the kernel's splitBridgeCommand for PREVIOUSLY_BRIDGE_CMD). */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out.filter((s) => s.length > 0);
}

/**
 * Resolve the adapter CLI to an argv array. The env override may carry extra
 * leading flags (e.g. `PREVIOUSLY_BRIDGE_KIMI_CMD="kimi --auto"`), which is
 * also how tests inject fixture CLIs (`node /path/to/fixture.js`).
 */
export function resolveCommandArgv(agent: BridgeAgent): string[] {
  const override = process.env[envKey(agent, 'CMD')]?.trim();
  return splitCommand(override ?? agent);
}

/** Per-adapter timeout env wins over the global one; defaults to ~10 min. */
export function resolveTimeoutMs(agent: BridgeAgent): number {
  const perAdapter = Number(process.env[envKey(agent, 'TIMEOUT_MS')]);
  if (Number.isFinite(perAdapter) && perAdapter > 0) return perAdapter;
  const global = Number(process.env.PREVIOUSLY_BRIDGE_TIMEOUT_MS);
  if (Number.isFinite(global) && global > 0) return global;
  return BRIDGE_DEFAULT_TIMEOUT_MS;
}

/** Assemble the single prompt handed to the CLI: assembled context + task. */
export function buildPrompt({ task, context }: BridgeTask): string {
  if (context === undefined || context === null || context.trim().length === 0) {
    return task;
  }
  return `<context>\n${context}\n</context>\n\n<task>\n${task}\n</task>`;
}

export interface ProcessOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError: NodeJS.ErrnoException | null;
}

const KILL_GRACE_MS = 3_000;

/**
 * Spawn a CLI, optionally pipe `input` to its stdin, capture stdout/stderr.
 * Never rejects: timeout, abort, and spawn failure are reported on the
 * outcome. Timeout and abort both SIGTERM first, then SIGKILL after a grace
 * period (on Windows kill() is already TerminateProcess).
 */
export function runProcess(
  command: string,
  args: string[],
  opts: { input?: string; timeoutMs: number; signal?: AbortSignal; cwd?: string },
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killer: ReturnType<typeof setTimeout> | undefined;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (killer !== undefined) clearTimeout(killer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted, spawnError });
    };

    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));

    const kill = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
      killer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, KILL_GRACE_MS);
      killer.unref?.();
    };

    const onAbort = (): void => {
      aborted = true;
      kill();
    };

    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    timer.unref?.();

    if (opts.signal !== undefined) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      spawnError = err;
      finish(null);
    });
    child.on('close', (code) => finish(code));

    // The CLI may exit before reading the prompt — an EPIPE here is already
    // reported honestly by the close event's non-zero code.
    child.stdin.on('error', () => {});
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

export interface NdjsonStream {
  events: unknown[];
  /** Non-empty lines that were not valid JSON. */
  badLines: string[];
}

export function parseNdjson(stdout: string): NdjsonStream {
  const events: unknown[] = [];
  const badLines: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      badLines.push(trimmed);
    }
  }
  return { events, badLines };
}

/** Extract display text from a message `content` that may be a plain string
 *  or an array of content blocks with `text` fields. */
export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { text: string } =>
          typeof block === 'object' &&
          block !== null &&
          typeof (block as { text?: unknown }).text === 'string',
      )
      .map((block) => block.text)
      .join('');
  }
  return '';
}

/**
 * Shared spawn-and-extract pipeline for NDJSON stream adapters. Every
 * failure mode becomes an honest BridgeError (design §9); the extract
 * callback is adapter-specific and pure.
 */
export async function runNdjsonAdapter(
  agent: BridgeAgent,
  argv: string[],
  opts: { input: string; timeoutMs: number; signal?: AbortSignal; cwd?: string },
  extract: (events: unknown[]) => string,
): Promise<string> {
  const command = argv[0];
  if (command === undefined) {
    throw new BridgeError('cli-not-found', `No command configured for the ${agent} adapter.`);
  }
  const outcome = await runProcess(command, argv.slice(1), opts);

  if (outcome.spawnError !== null) {
    if (outcome.spawnError.code === 'ENOENT') {
      throw new BridgeError(
        'cli-not-found',
        `${agent} CLI not found: "${command}". Install it, or point ${envKey(agent, 'CMD')} at the binary.`,
      );
    }
    throw new BridgeError('cli-error', `Failed to start ${agent} CLI "${command}": ${outcome.spawnError.message}`);
  }
  if (outcome.aborted) {
    throw new BridgeError('aborted', `${agent} dispatch was aborted (bridge-exec received a termination signal).`);
  }
  if (outcome.timedOut) {
    throw new BridgeError(
      'timeout',
      `${agent} CLI timed out after ${opts.timeoutMs}ms and was killed ` +
        `(${envKey(agent, 'TIMEOUT_MS')} / PREVIOUSLY_BRIDGE_TIMEOUT_MS). ` +
        `The task may be partially done on the CLI side — verify before retrying.`,
    );
  }
  if (outcome.code !== 0) {
    // Auth/quota/cold-start failures land here: surface the CLI's own words.
    const tail = outcome.stderr.trim().slice(-2000);
    throw new BridgeError(
      'cli-error',
      `${agent} CLI exited with code ${outcome.code === null ? 'null (killed)' : outcome.code}.` +
        (tail ? ` stderr: ${tail}` : ''),
    );
  }

  const { events, badLines } = parseNdjson(outcome.stdout);
  const text = extract(events).trim();
  if (text.length === 0) {
    throw new BridgeError(
      'empty-result',
      `${agent} CLI exited 0 but its stream-json output contained no result text.` +
        (badLines.length > 0 ? ` ${badLines.length} non-JSON line(s), first: ${badLines[0]!.slice(0, 200)}` : ''),
    );
  }
  return text;
}

/** which/where presence check for `previously status` — honest "not found". */
export function checkCliPresence(agent: BridgeAgent): { found: boolean; detail: string } {
  const argv = resolveCommandArgv(agent);
  const command = argv[0] ?? agent;
  // Path-like values (absolute, relative, or fixture scripts) check the fs.
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command)
      ? { found: true, detail: command }
      : { found: false, detail: `${command} does not exist` };
  }
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(probe, [command], { stdio: 'pipe', encoding: 'utf8', windowsHide: true });
  if (res.status === 0 && typeof res.stdout === 'string' && res.stdout.trim().length > 0) {
    return { found: true, detail: res.stdout.trim().split('\n')[0]!.trim() };
  }
  const override = process.env[envKey(agent, 'CMD')]?.trim();
  return {
    found: false,
    detail: `"${command}" not on PATH` + (override !== undefined && override !== '' ? ` (from ${envKey(agent, 'CMD')})` : ''),
  };
}
