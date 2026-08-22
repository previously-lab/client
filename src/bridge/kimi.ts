import { buildPrompt, resolveCommandArgv, runNdjsonAdapter, summarizeToolInput, textFromContent } from './runner.js';
import type { BridgeAdapter, BridgeTask, BridgeToolEvent, DispatchOptions } from './types.js';

/**
 * Kimi Code adapter: `kimi -p "<prompt>" --output-format stream-json`.
 *
 * Verified on this machine against kimi 0.34.0 (2026-08): a successful run
 * emits NDJSON meta events plus `{"role":"assistant","content":"..."}` lines
 * and exits 0; the result text is the last assistant message's content.
 * Tool activity (live probe, same version):
 *   {"role":"assistant","tool_calls":[{"type":"function","id":"...",
 *     "function":{"name":"Read","arguments":"{\"path\":\"...\"}"}}]}
 *   {"role":"tool","tool_call_id":"...","content":"..."}
 * The tool result line carries no error flag, so completions are honestly
 * reported as "ok" (kimi surfaces failures as text inside content).
 * `-p` requires the prompt as an option value, so it travels via argv (unlike
 * the claude adapter's stdin transport) — very large assembled contexts may
 * hit the Windows argv limit and fail honestly (spawn error).
 * `-p` runs non-interactively; tool-approval behavior under `-p` without
 * `--auto`/`--yolo` is unverified — users who need tools can wrap the binary
 * via PREVIOUSLY_BRIDGE_KIMI_CMD="kimi --auto".
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Pure stream extraction, exported for tests. */
export function extractKimiResult(events: unknown[]): string {
  let lastText = '';
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.role === 'assistant') {
      const text = textFromContent(event.content);
      if (text.trim().length > 0) lastText = text;
    }
  }
  return lastText;
}

/**
 * Stateful deriver (one per dispatch): kimi stream-json → protocol-2 tool
 * events. An assistant line carrying `tool_calls` starts one event per call
 * (`function.arguments` is a JSON string — parsed for the summary); a
 * `role:"tool"` line closes it as ok (kimi emits no error flag on results).
 */
export function createKimiToolEventDeriver(): (event: unknown) => BridgeToolEvent[] {
  const calls = new Map<string, { name: string; summary: string }>();
  return (event) => {
    if (!isRecord(event)) return [];
    if (event.role === 'assistant' && Array.isArray(event.tool_calls)) {
      const out: BridgeToolEvent[] = [];
      for (const call of event.tool_calls) {
        if (!isRecord(call) || !isRecord(call.function) || typeof call.function.name !== 'string') continue;
        const name = call.function.name;
        let args: unknown = call.function.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            // Leave the raw string as the summary source.
          }
        }
        const summary = summarizeToolInput(name, args);
        if (typeof call.id === 'string') calls.set(call.id, { name, summary });
        out.push({ name, summary, status: 'start' });
      }
      return out;
    }
    if (event.role === 'tool') {
      const call = typeof event.tool_call_id === 'string' ? calls.get(event.tool_call_id) : undefined;
      return [{ name: call?.name ?? 'tool', summary: call?.summary ?? '', status: 'ok' }];
    }
    return [];
  };
}

export const kimiAdapter: BridgeAdapter = {
  agent: 'kimi',
  dispatch(task: BridgeTask, opts: DispatchOptions): Promise<string> {
    const argv = resolveCommandArgv('kimi');
    const args = [...argv.slice(1), '-p', buildPrompt(task), '--output-format', 'stream-json'];
    if (opts.tuning?.model !== undefined) args.push('-m', opts.tuning.model);
    const derive = createKimiToolEventDeriver();
    return runNdjsonAdapter(
      'kimi',
      [argv[0] ?? 'kimi', ...args],
      {
        input: '',
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        cwd: opts.cwd,
        onNdjsonEvent:
          opts.onEvent === undefined
            ? undefined
            : (event) => {
                for (const te of derive(event)) opts.onEvent!(te);
              },
      },
      extractKimiResult,
    );
  },
};
