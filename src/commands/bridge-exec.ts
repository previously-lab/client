import { parseArgs } from 'node:util';
import { rmSync } from 'node:fs';
import {
  BRIDGE_PHASES,
  BridgeError,
  dispatchBridgeTask,
  isBridgeAgent,
  isBridgePhase,
  resolveTimeoutMs,
  type BridgeAgent,
  type BridgeTask,
  type DispatchOptions,
} from '../bridge/index.js';
import { createEventCollector } from '../bridge/events.js';
import { loadConfig } from '../lib/config.js';
import { resolvePaths } from '../lib/paths.js';
import { renderPhaseSkillDoc } from '../lib/phase-skills.js';
import { materializeBridgeWorkspace, sweepStaleBridgeWorkspaces } from '../lib/skills.js';

/**
 * `previously bridge-exec` — the kernel-side half of the subscription bridge
 * contract (agent repo delegateTask executor, design §7):
 *
 *   stdin:  {"task": string, "context": string | null, "protocol"?: 2,
 *            "phase"?: "chat" | "housekeeping",
 *            "skills"?: { <name>: <markdown text> }}                     (JSON)
 *   stdout: protocol absent — the adapter's final result text (raw, no framing)
 *           protocol 2      — NDJSON: one {"event":{name,summary,status}} line
 *           per tool event and advisory {"delta":<text chunk>} lines as the
 *           answer streams (claude: token-level chat partials + housekeeping
 *           narration; codex/kimi: housekeeping narration only, derived from
 *           reasoning/prose lines — no token-level stream exists), then a final
 *           {"protocol":2,"result":<text>,"events":[...]} line. The envelope
 *           stays the source of truth; deltas may be discarded by consumers.
 *   exit:   0 on success; 1 on adapter failure; 2 on usage errors
 *           (bad flags, malformed stdin payload, no agent configured).
 *           Diagnostics always go to stderr — stdout stays a clean result.
 *
 * The kernel treats exit 0 + empty stdout as malformed, so adapters must
 * never succeed with empty output (they raise 'empty-result' instead).
 *
 * Agent selection: --agent claude|codex|kimi, else the per-spawn
 * PREVIOUSLY_BRAIN_AGENT env override (the kernel sets it per chat call),
 * else config executionBackend. Model/effort tuning comes from the
 * config.agents[agent] block (absent = CLI defaults).
 *
 * Before spawning, the selected CLI gets a per-call temp workspace (cwd)
 * carrying its cwd-convention instruction file (CLAUDE.md for claude,
 * AGENTS.md for codex/kimi), with MEMORY_ROOT filled from config. The
 * document is the generic "Previously memory" skill — or, when the payload
 * carries `phase` (experimental phase outsourcing), the phase-specific doc:
 * 'chat' (constrained reader-tool contract) or 'housekeeping' (read-only
 * evidence rules; the analysis/output spec travels in the task input).
 * Payload `skills` entries are materialized as `skills/<name>.md` beside it.
 * Docs and skills alike render `{{PREVIOUSLY_CMD}}` as the bare registered
 * command name (`previously`): the spawned agent invokes reader commands
 * through its own shell, which resolves the global shim exactly like a user
 * typing it. The workspace is removed in a finally block after the
 * call.
 *
 * When the payload carries `phase`, the spawned agent also inherits
 * PREVIOUSLY_READER_SCOPE=<phase>: the reader commands hard-gate themselves
 * on it (see src/lib/reader-scope.ts) — housekeeping loses timeline/strands/
 * slicesummary, and `card bootstrap` is refused under any scope. Without a
 * phase the env is left untouched (legacy path: everything allowed).
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
  if (rec.protocol !== undefined && rec.protocol !== 2) {
    throw new Error('stdin payload "protocol" must be 2 when present (absent = legacy plain-text protocol)');
  }
  if (rec.phase !== undefined && !isBridgePhase(rec.phase)) {
    throw new Error(`stdin payload "phase" must be one of ${BRIDGE_PHASES.join('|')} when present`);
  }
  let skills: Record<string, string> | undefined;
  if (rec.skills !== undefined) {
    if (typeof rec.skills !== 'object' || rec.skills === null || Array.isArray(rec.skills)) {
      throw new Error('stdin payload "skills" must be an object mapping skill names to markdown strings');
    }
    skills = {};
    for (const [name, content] of Object.entries(rec.skills)) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new Error(
          `stdin payload "skills" keys must match [A-Za-z0-9_-]+ (they become file names), got: ${JSON.stringify(name)}`,
        );
      }
      if (typeof content !== 'string') {
        throw new Error(`stdin payload "skills.${name}" must be a string`);
      }
      skills[name] = content;
    }
  }
  return {
    task: rec.task,
    context: (rec.context as string | null | undefined) ?? null,
    ...(rec.protocol === 2 ? { protocol: 2 as const } : {}),
    ...(rec.phase !== undefined ? { phase: rec.phase } : {}),
    ...(skills !== undefined ? { skills } : {}),
  };
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
  let tuning: DispatchOptions['tuning'];
  try {
    task = parsePayload(raw);
    const config = loadConfig(resolvePaths());
    agent = resolveAgent(values.agent, config.executionBackend);
    memoryRoot = config.memoryRoot;
    tuning = config.agents?.[agent];
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  // Per-call workspace: the agent CLI runs with cwd = a temp dir carrying
  // its cwd-convention instruction file (CLAUDE.md / AGENTS.md) filled with
  // the skill document — the phase-specific doc when the payload delegates a
  // whole workflow phase, else the generic memory doc (legacy delegateTask
  // path, byte-compatible). Payload `skills` entries are materialized as
  // skills/<name>.md beside it. Docs and skills alike render
  // `{{PREVIOUSLY_CMD}}` as the bare registered command name: the spawned
  // agent invokes reader commands through its own shell, which resolves the
  // global `previously` shim exactly like a user typing it would.
  // Hard-killed predecessors (TerminateProcess runs no finally) leave their
  // workspaces behind — sweep them before making our own.
  sweepStaleBridgeWorkspaces();
  const workspace = materializeBridgeWorkspace(
    agent,
    memoryRoot,
    task.phase !== undefined ? renderPhaseSkillDoc(task.phase, memoryRoot) : undefined,
    { skills: task.skills },
  );

  // Phase outsourcing: the spawned agent inherits this scope and the reader
  // commands hard-gate on it (src/lib/reader-scope.ts). This process lives
  // for one call; restore the previous value in finally so in-process
  // callers (tests) never leak a scope.
  const previousScope = process.env.PREVIOUSLY_READER_SCOPE;
  if (task.phase !== undefined) {
    process.env.PREVIOUSLY_READER_SCOPE = task.phase;
  }

  // Forward termination to the CLI child: kill-on-SIGTERM, no orphans.
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    // Protocol 2: stream each tool event live as an NDJSON {"event":...}
    // line and each answer-text chunk as a {"delta":...} line, then close
    // with the final {"protocol":2,...} envelope. Legacy protocol (absent)
    // keeps stdout a raw result for old kernels — deltas are swallowed
    // (no sink is passed, so the adapter never derives them).
    const collector =
      task.protocol === 2
        ? createEventCollector((event) => process.stdout.write(JSON.stringify({ event }) + '\n'))
        : null;
    const text = await dispatchBridgeTask(agent, task, {
      timeoutMs: resolveTimeoutMs(agent),
      signal: controller.signal,
      cwd: workspace.dir,
      tuning,
      onEvent: collector === null ? undefined : (event) => collector.record(event),
      onDelta:
        task.protocol === 2
          ? (delta) => process.stdout.write(JSON.stringify({ delta }) + '\n')
          : undefined,
    });
    if (collector !== null) {
      const envelope = { protocol: 2 as const, result: text, events: collector.finalize() };
      process.stdout.write(JSON.stringify(envelope) + '\n');
    } else {
      console.log(text);
    }
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
    if (task.phase !== undefined) {
      if (previousScope === undefined) delete process.env.PREVIOUSLY_READER_SCOPE;
      else process.env.PREVIOUSLY_READER_SCOPE = previousScope;
    }
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
