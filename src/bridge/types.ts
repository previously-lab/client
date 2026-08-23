/**
 * Subscription bridge (design doc §7): the kernel's delegateTask tool pipes
 * `{ task, context }` JSON to `previously bridge-exec` on stdin; the bridge
 * drives a local subscription CLI (Claude Code / Codex / Kimi Code) in
 * headless mode and returns the final result text on stdout. The bridge owns
 * the "hands" only — persona and memory protocol stay in the kernel (§7.2).
 */

export type BridgeAgent = 'claude' | 'codex' | 'kimi';
export const BRIDGE_AGENTS: BridgeAgent[] = ['claude', 'codex', 'kimi'];

/**
 * Phase outsourcing (experimental, design doc §phase-outsourcing): the kernel
 * delegates a whole workflow phase as one bridge call. Absent = the legacy
 * per-agent delegateTask path (generic memory skill doc in the workspace).
 */
export type BridgePhase = 'chat' | 'housekeeping';
export const BRIDGE_PHASES: BridgePhase[] = ['chat', 'housekeeping'];

/** The payload the kernel's delegateTask executor writes to our stdin. */
export interface BridgeTask {
  task: string;
  context?: string | null;
  /**
   * Wire protocol version. Absent: raw result text on stdout (v1). 2: NDJSON
   * envelope — live `{"event":...}` tool-event lines and (claude only)
   * advisory `{"delta":...}` answer-text chunks, followed by a final
   * `{"protocol":2,"result":...,"events":[...]}` line. The envelope remains
   * the source of truth; deltas are presentation-only and may be discarded.
   */
  protocol?: 2;
  /** When present, the workspace carries the phase-specific skill doc. */
  phase?: BridgePhase;
}

/** One tool invocation as surfaced on the protocol-2 event stream. */
export interface BridgeToolEvent {
  /** Tool name (e.g. "Bash", "Read"); codex reports its item type. */
  name: string;
  /** Truncated single-line summary of the call input. */
  summary: string;
  status: 'start' | 'ok' | 'error';
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
  /**
   * Live tool-event sink (protocol 2): called with each derived tool event as
   * the CLI's NDJSON stream arrives. Absent sink = events are not derived.
   */
  onEvent?: (event: BridgeToolEvent) => void;
  /**
   * Live answer-text delta sink (protocol 2, claude adapter only): called with
   * each text chunk as the CLI streams its answer. Advisory presentation only
   * — the final result string stays the source of truth. Absent sink = no
   * deltas are derived (codex/kimi never produce any).
   */
  onDelta?: (text: string) => void;
  /** Per-agent tuning from config.agents (model / effort flags). */
  tuning?: AgentTuning;
}

/** Per-agent flag tuning handed to an adapter (config.agents[agent]). */
export interface AgentTuning {
  model?: string;
  /** Reasoning effort; only adapters whose CLI supports it honor this. */
  effort?: 'low' | 'medium' | 'high';
}

/** One adapter per subscription CLI: task in → final result text out. */
export interface BridgeAdapter {
  readonly agent: BridgeAgent;
  dispatch(task: BridgeTask, opts: DispatchOptions): Promise<string>;
}
