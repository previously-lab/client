import type { BridgePhase } from '../bridge/types.js';
import { MEMORY_ROOT_PLACEHOLDER, PREVIOUSLY_CMD_PLACEHOLDER } from './skills.js';

/**
 * Phase-aware skill documents (experimental phase outsourcing): when the
 * kernel delegates a whole workflow phase via the bridge payload's `phase`
 * field, the per-call workspace carries one of these documents instead of the
 * generic memory skill doc. Same delivery channel; two placeholders are
 * filled at render time: `{{MEMORY_ROOT}}` (the absolute memory path) and
 * `{{PREVIOUSLY_CMD}}` (the bare registered command name — the spawned agent
 * runs reader commands through its own shell, which resolves the global
 * `previously` shim exactly like a user typing it would).
 *
 * These documents are a THIN ADAPTATION LAYER: they pin the mechanism
 * (which reader commands exist, the read-only rules, the output contract).
 * All business rules — when to recall, how to analyze a turn, the mutation
 * vocabulary, the output schema — live in the kernel runtime and travel in
 * the bridge payload's task/context and `skills` entries, never here.
 *
 * The documents are otherwise fully static; per-turn dynamic data (messages,
 * card, strands menu) travels in the bridge payload's task/context, never
 * here.
 */

const CHAT_DOC_TEMPLATE = `# Previously Chat Phase

You are the user's personal agent, running on the user's own machine inside
Previously. Answer the user's turn, drawing on Previously's episodic memory
of past conversations when it matters.

## Memory tools — the ONLY memory access

Memory lives under this absolute path:

    {{MEMORY_ROOT}}

You access it ONLY through these reader commands:

- \`{{PREVIOUSLY_CMD}} timeline [--month YYYY-MM] [--day MM-DD] [--from YYYY-MM-DD --to YYYY-MM-DD]\`
  — the human timeline, optionally narrowed to one month / one day / a date
  window.
- \`{{PREVIOUSLY_CMD}} readslice <sliceId> [--start N --end N | --last N | --search <text> | --turns a-b]\`
  — the full conversation record of one slice (\`timeline/core.md\`),
  optionally narrowed by line range, tail, keyword, or turn range.
- \`{{PREVIOUSLY_CMD}} strands [name]\` — list all strands with slice counts, or one
  strand's slice ids.
- \`{{PREVIOUSLY_CMD}} card [--slice <sliceId>]\` — the live card, or one slice's
  card snapshot.
- \`{{PREVIOUSLY_CMD}} slicesummary <sliceId>\` — ONLY the slice's frontmatter
  (focus/summary/tags/tone), never the body.
- \`{{PREVIOUSLY_CMD}} agentlog <sliceId> [--start N --end N]\` — the slice's
  cognition record (\`timeline/agent.md\`).

Strict rules:

- NEVER read, search, or list the memory directory directly with file tools
  (Read/Grep/Glob/cat/...). The commands above are the whole interface.
- NEVER create, modify, rename, or delete anything under the memory root.
  Persistence is the Previously kernel's job, never yours.
- Never fabricate memories. If a lookup finds nothing, say so plainly.

## Questions about the past

When the user's turn touches their past — prior conversations, decisions,
preferences, people, projects, dates — retrieve before answering:

- If your runtime supports sub-agents and your workspace carries
  \`skills/recall.md\`: spawn a sub-agent equipped with ONLY the reader
  commands above, have it execute the \`skills/recall.md\` spec, and let it
  report back POINTERS ONLY (slice ids + relevance), so search noise stays
  out of your main context. Then open the promising slices with
  \`{{PREVIOUSLY_CMD}} readslice\` before citing specifics.
- Without sub-agent support (or without \`skills/recall.md\` in the
  workspace), do the same search yourself with the command list above.

## Output contract

Your final reply is rendered verbatim in a web chat UI. It must contain ONLY
the answer text for the user: no tool-call narration, no logs, no
"I searched the memory" preamble, no markdown fences around the whole reply.
`;

const HOUSEKEEPING_DOC_TEMPLATE = `# Previously Housekeeping Phase

You perform the Previously housekeeping phase for ONE conversation turn. You
run once per turn. The kernel validates and applies your report; you never
write anything yourself.

Memory lives under this absolute path:

    {{MEMORY_ROOT}}

## Evidence tools (read-only — card-evolution forensics ONLY)

Memory reads exist for exactly one purpose in this phase: gathering evidence
for card evolution / self-model updates. Analysis, tagging, backfill, and
strand merging work EXCLUSIVELY from the data provided in this call's
task/context — they never read memory.

You MAY gather card-evolution evidence, but ONLY through:

- \`{{PREVIOUSLY_CMD}} readslice <sliceId> [--start N --end N | --last N | --search <text> | --turns a-b]\`
  — the full conversation record of one slice (\`timeline/core.md\`).
- \`{{PREVIOUSLY_CMD}} agentlog <sliceId> [--start N --end N]\` — the slice's
  cognition record (\`timeline/agent.md\`).
- \`{{PREVIOUSLY_CMD}} card [--slice <sliceId>]\` — the live card, or one slice's
  card snapshot.

\`timeline\`, \`strands\`, and \`slicesummary\` are NOT available in this phase —
the reader gate refuses them (exit 1). \`card bootstrap\` is refused under any
phase scope.

Strict rules:

- NEVER read, search, or list the memory directory directly with file tools.
- NEVER write anything anywhere under the memory root. Your output is a
  report; the kernel is the only writer.

## The task input is the spec

The complete analysis rules, mutation vocabulary, and output schema travel in
this call's task input — it is the source of truth. Follow it exactly.
`;

/**
 * Render the phase skill document with the absolute memory root and the
 * command prefix filled in. bridge-exec renders `{{PREVIOUSLY_CMD}}` with the
 * default — the bare registered command name (`previously`): the spawned
 * agent invokes reader commands through its own shell, which resolves the
 * global shim exactly like a user typing it would. The custom-prefix
 * parameter remains only for callers/tests that need a different spelling.
 */
export function renderPhaseSkillDoc(
  phase: BridgePhase,
  memoryRoot: string,
  previouslyCmd: string = 'previously',
): string {
  const template = phase === 'chat' ? CHAT_DOC_TEMPLATE : HOUSEKEEPING_DOC_TEMPLATE;
  return template
    .split(MEMORY_ROOT_PLACEHOLDER).join(memoryRoot)
    .split(PREVIOUSLY_CMD_PLACEHOLDER).join(previouslyCmd);
}
