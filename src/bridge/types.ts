/**
 * Subscription bridge (design doc §7): the kernel's delegateTask tool pipes
 * `{ task, context }` JSON to `previously bridge-exec` on stdin; the bridge
 * drives a local subscription CLI (Claude Code / Codex / Kimi Code) in
 * headless mode and returns the final result text on stdout. The bridge owns
 * the "hands" only — persona and memory protocol stay in the kernel (§7.2).
 */

export type BridgeAgent = 'claude' | 'codex' | 'kimi';
export const BRIDGE_AGENTS: BridgeAgent[] = ['claude', 'codex', 'kimi'];

/** The payload the kernel's delegateTask executor writes to our stdin. */
export interface BridgeTask {
  task: string;
  context?: string | null;
}

export type BridgeFailureReason =
  | 'cli-not-found'
  | 'cli-error'
  | 'timeout'
  | 'malformed-stream'
  | 'empty-result'
  | 'aborted';

/**
 * Honest bridge failure (design §9): the message must be actionable enough
 * for the kernel — and ultimately the user — to decide what to do next.
 * Never fabricate output instead.
 */
export class BridgeError extends Error {
  constructor(
    readonly reason: BridgeFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

export interface DispatchOptions {
  timeoutMs: number;
  /** Forwarded from the bridge-exec process so SIGTERM/SIGINT kills the CLI. */
  signal?: AbortSignal;
  /**
   * Working directory for the CLI child. bridge-exec sets this to a per-call
   * temp workspace carrying the memory skill file (CLAUDE.md / AGENTS.md).
   */
  cwd?: string;
}

/** One adapter per subscription CLI: task in → final result text out. */
export interface BridgeAdapter {
  readonly agent: BridgeAgent;
  dispatch(task: BridgeTask, opts: DispatchOptions): Promise<string>;
}
