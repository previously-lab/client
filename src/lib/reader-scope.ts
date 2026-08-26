/**
 * Reader-command phase scope gate (phase outsourcing, design §7).
 *
 * bridge-exec sets PREVIOUSLY_READER_SCOPE to the delegated phase before
 * spawning the agent CLI; the six reader commands (readslice / timeline /
 * strands / card / slicesummary / agentlog) consult it at entry and refuse
 * whatever the phase does not allow — exit 1 with an honest stderr note
 * naming the phase and the command:
 *
 *   unset / empty  legacy path (a real user typing the command, or a
 *                  phase-less delegateTask call): everything allowed
 *   chat           all six reader commands
 *   housekeeping   readslice / agentlog / card only — the Previously Agent
 *                  (card evolution) is the sole housekeeping reader
 *   unknown value  treated as housekeeping (strictest reading)
 *
 * `card bootstrap` (the token-spending initialization) is refused under ANY
 * non-empty scope: bridge-phase calls never run it.
 */

export const READER_SCOPE_ENV = 'PREVIOUSLY_READER_SCOPE';

export type ReaderScope = 'chat' | 'housekeeping';

const HOUSEKEEPING_COMMANDS = new Set(['readslice', 'agentlog', 'card']);

/**
 * Pure: normalize the raw env value. Unset/empty means no gate; an unknown
 * non-empty value degrades to the strictest scope.
 */
export function resolveReaderScope(raw: string | undefined): ReaderScope | null {
  if (raw === undefined || raw.trim() === '') return null;
  return raw === 'chat' ? 'chat' : 'housekeeping';
}

/** Pure: is this reader command allowed under the given scope? */
export function isReaderCommandAllowed(command: string, scope: ReaderScope | null): boolean {
  if (scope === null) return true;
  if (command === 'card bootstrap') return false;
  if (scope === 'chat') return true;
  return HOUSEKEEPING_COMMANDS.has(command);
}

/** Pure: the one-line denial for stderr, naming the phase and the command. */
export function readerScopeError(command: string, scope: ReaderScope): string {
  if (command === 'card bootstrap') {
    return (
      `card bootstrap is refused under ${READER_SCOPE_ENV}=${scope}: it spends tokens on ` +
      'initialization and is never a valid bridge-phase call. Run it directly (no scope set).'
    );
  }
  const hint =
    scope === 'housekeeping'
      ? ' Housekeeping reads memory only via: readslice, agentlog, card.'
      : '';
  return `${command} is not available in the ${scope} phase (${READER_SCOPE_ENV}=${scope}).${hint}`;
}

/**
 * Thin env-reading wrapper over the pure functions: returns the denial
 * message when the current scope forbids the command, null when allowed.
 */
export function assertReaderAllowed(command: string): string | null {
  const scope = resolveReaderScope(process.env[READER_SCOPE_ENV]);
  if (isReaderCommandAllowed(command, scope)) return null;
  // scope is non-null here: a null scope allows everything.
  return readerScopeError(command, scope ?? 'housekeeping');
}
