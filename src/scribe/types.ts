/**
 * Shared types for the Scribe (design doc §5): a read-only observer over other
 * agents' session logs that transcribes them into Previously time slices.
 */

export type ScribeSource = 'claude-code' | 'codex' | 'kimi-code' | 'gemini';

export const SCRIBE_SOURCES: readonly ScribeSource[] = ['claude-code', 'codex', 'kimi-code', 'gemini'];

/**
 * A normalized conversational event extracted from any agent's log line.
 *
 * The model is exchange-oriented: parsers emit a flat stream, the slicer
 * assembles it into turns (one user question + everything the agent did
 * until the next user message = one turn) and splits presentation
 * (core.md: user/agent speech) from process (agent.md: thinking + tools),
 * mirroring the kernel's slice structure.
 */
export type TranscriptEvent =
  | { timestamp: string; kind: 'user'; text: string }
  | { timestamp: string; kind: 'agent-text'; text: string }
  /** Model reasoning (claude thinking blocks, kimi think parts). */
  | { timestamp: string; kind: 'thinking'; text: string }
  /** text = truncated input summary; toolCallId pairs with the result. */
  | { timestamp: string; kind: 'tool-call'; toolName: string; text: string; toolCallId?: string }
  /** text = truncated output excerpt; toolCallId pairs with the call. */
  | { timestamp: string; kind: 'tool-result'; toolName?: string; toolCallId?: string; text: string; isError: boolean };

/**
 * Result of parsing one raw log line.
 *
 * Format-tax strategy (§5.3): a line that cannot be parsed never kills the
 * pipeline — its raw text lands in `appendix` (counted as a parse error),
 * while recognized-but-non-conversational lines (metadata, snapshots) are
 * skipped quietly with empty events and empty appendix.
 */
export interface ParseOutcome {
  events: TranscriptEvent[];
  /** Raw lines that failed to parse (0 or 1 entries per call). */
  appendix: string[];
  /** Session id carried by this line, when the format exposes one. */
  sessionId?: string;
}

export type LineParser = (line: string) => ParseOutcome;

/**
 * Accumulated per-session state — the incrementally-grown transcript plus its
 * appendix bucket. Persisted under PREVIOUSLY_HOME/scribe/sessions/ so a
 * restart can resume from the byte-offset cursor without re-reading the log.
 */
export interface SessionState {
  source: ScribeSource;
  sessionId: string;
  /** Slice id assigned from the first event's timestamp; null until then. */
  sliceId: string | null;
  events: TranscriptEvent[];
  /** Raw lines that failed to parse, kept verbatim for the appendix file. */
  appendix: string[];
  parseErrors: number;
}

/** Per-source watch root resolution. */
export type ScribeRoots = Record<ScribeSource, string>;
