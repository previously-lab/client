import { parseArgs } from 'node:util';
import { rmSync } from 'node:fs';
import {
  BridgeError,
  dispatchBridgeTask,
  isBridgeAgent,
  resolveTimeoutMs,
  type BridgeAgent,
  type BridgeTask,
} from '../bridge/index.js';
import { loadConfig } from '../lib/config.js';
import { resolvePaths } from '../lib/paths.js';
import { materializeBridgeWorkspace } from '../lib/skills.js';

/**
 * `previously bridge-exec` — the kernel-side half of the subscription bridge
 * contract (agent repo delegateTask executor, design §7):
 *
 *   stdin:  {"task": string, "context": string | null}   (JSON)
 *   stdout: the adapter's final result text (raw, no framing)
 *   exit:   0 on success; 1 on adapter failure; 2 on usage errors
 *           (bad flags, malformed stdin payload, no agent configured).
 *           Diagnostics always go to stderr — stdout stays a clean result.
 *
 * The kernel treats exit 0 + empty stdout as malformed, so adapters must
 * never succeed with empty output (they raise 'empty-result' instead).
 *
 * Agent selection: --agent claude|codex|kimi, else the per-spawn
 * PREVIOUSLY_BRAIN_AGENT env override (the kernel sets it per chat call),
 * else config executionBackend.
 *
 * Before spawning, the selected CLI gets a per-call temp workspace (cwd)
 * carrying the "Previously memory" skill document as its cwd-convention
 * instruction file (CLAUDE.md for claude, AGENTS.md for codex/kimi), with
 * MEMORY_ROOT filled from config. The workspace is removed in a finally
 * block after the call.
 */

export interface BridgeExecOptions {
  /** Test hook: provide the stdin payload instead of reading process.stdin. */
  stdin?: string;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error('bridge-exec expects a JSON payload on stdin (piped by the kernel delegateTask tool).');
  }
  return new Promise((resolveStdin, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', () => resolveStdin(data));
    process.stdin.on('error', reject);
  });
}

function parsePayload(raw: string): BridgeTask {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`stdin payload is not valid JSON: ${raw.trim().slice(0, 200)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('stdin payload must be a JSON object: {"task": string, "context": string | null}');
  }
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.task !== 'string' || rec.task.trim().length === 0) {
    throw new Error('stdin payload must contain a non-empty string "task" field');
  }
  if (rec.context !== undefined && rec.context !== null && typeof rec.context !== 'string') {
    throw new Error('stdin payload "context" must be a string or null');
  }
  return { task: rec.task, context: (rec.context as string | null | undefined) ?? null };
}

function resolveAgent(flag: string | undefined, configured: string | null): BridgeAgent {
  if (flag !== undefined) {
    if (isBridgeAgent(flag)) return flag;
    throw new Error(`Unknown --agent value: ${flag} (expected claude|codex|kimi)`);
  }
  const envAgent = process.env.PREVIOUSLY_BRAIN_AGENT?.trim();
  if (envAgent !== undefined && envAgent !== '') {
    if (isBridgeAgent(envAgent)) return envAgent;
    throw new Error(`Unknown PREVIOUSLY_BRAIN_AGENT value: ${envAgent} (expected claude|codex|kimi)`);
  }
  if (configured !== null && isBridgeAgent(configured)) return configured;
  if (configured !== null) {
    throw new Error(
      `executionBackend is "${configured}", which is not a subscription bridge CLI. ` +
        `Pass --agent claude|codex|kimi, or set executionBackend with \`previously init --backend ...\`.`,
    );
  }
  throw new Error(
    'No bridge agent selected. Pass --agent claude|codex|kimi, or set a default with ' +
      '`previously init --backend claude|codex|kimi`.',
  );
}

export async function run(args: string[], opts: BridgeExecOptions = {}): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { agent: { type: 'string' } },
  });

  let raw: string;
  try {
    raw = opts.stdin ?? (await readStdin());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  let task: BridgeTask;
  let agent: BridgeAgent;
  let memoryRoot: string;
  try {
    task = parsePayload(raw);
    const config = loadConfig(resolvePaths());
    agent = resolveAgent(values.agent, config.executionBackend);
    memoryRoot = config.memoryRoot;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  // Per-call workspace: the agent CLI runs with cwd = a temp dir carrying
  // its cwd-convention instruction file (CLAUDE.md / AGENTS.md) filled with
  // the memory skill document — zero user config needed on the agent side.
  const workspace = materializeBridgeWorkspace(agent, memoryRoot);

  // Forward termination to the CLI child: kill-on-SIGTERM, no orphans.
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const text = await dispatchBridgeTask(agent, task, {
      timeoutMs: resolveTimeoutMs(agent),
      signal: controller.signal,
      cwd: workspace.dir,
    });
    console.log(text);
    return 0;
  } catch (err) {
    if (err instanceof BridgeError) {
      console.error(`bridge-exec (${agent}) failed [${err.reason}]: ${err.message}`);
    } else {
      console.error(`bridge-exec (${agent}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 1;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    // Workspace cleanup is best-effort: a locked temp dir must never fail a
    // call that already produced its result.
    try {
      rmSync(workspace.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (err) {
      console.error(
        `bridge-exec: could not remove temp workspace ${workspace.dir} ` +
          `(${err instanceof Error ? err.message : err}); leaving it for the OS temp cleaner`,
      );
    }
  }
}
