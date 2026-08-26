import { describe, expect, it } from 'vitest';
import { renderPhaseSkillDoc } from '../src/lib/phase-skills.js';
import { MEMORY_ROOT_PLACEHOLDER } from '../src/lib/skills.js';

const ROOT = 'C:\\mem\\root';

const SIX_READER_COMMANDS = [
  'previously timeline [--month YYYY-MM] [--day MM-DD] [--from YYYY-MM-DD --to YYYY-MM-DD]',
  'previously readslice <sliceId> [--start N --end N | --last N | --search <text> | --turns a-b]',
  'previously strands [name]',
  'previously card [--slice <sliceId>]',
  'previously slicesummary <sliceId>',
  'previously agentlog <sliceId> [--start N --end N]',
];

const THREE_HOUSEKEEPING_COMMANDS = [
  'previously readslice <sliceId> [--start N --end N | --last N | --search <text> | --turns a-b]',
  'previously agentlog <sliceId> [--start N --end N]',
  'previously card [--slice <sliceId>]',
];

const HOUSEKEEPING_DENIED_COMMAND_LINES = [
  'previously timeline [--month YYYY-MM] [--day MM-DD] [--from YYYY-MM-DD --to YYYY-MM-DD]',
  'previously strands [name]',
  'previously slicesummary <sliceId>',
];

describe('renderPhaseSkillDoc', () => {
  it('fills the MEMORY_ROOT placeholder in both phases and leaves none behind', () => {
    for (const phase of ['chat', 'housekeeping'] as const) {
      const doc = renderPhaseSkillDoc(phase, ROOT);
      expect(doc).not.toContain(MEMORY_ROOT_PLACEHOLDER);
      expect(doc).toContain(ROOT);
    }
  });

  it('fills the PREVIOUSLY_CMD placeholder (default bare name, custom prefix honored)', () => {
    for (const phase of ['chat', 'housekeeping'] as const) {
      const doc = renderPhaseSkillDoc(phase, ROOT);
      expect(doc).not.toContain('{{PREVIOUSLY_CMD}}');
      expect(doc).toContain('previously readslice');
      const prefixed = renderPhaseSkillDoc(phase, ROOT, '"node" "C:\\x\\cli.js"');
      expect(prefixed).toContain('"node" "C:\\x\\cli.js" readslice');
      expect(prefixed).not.toContain('{{PREVIOUSLY_CMD}}');
    }
  });

  it('chat: states the role, the strict rules, and the verbatim-reply output contract', () => {
    const doc = renderPhaseSkillDoc('chat', ROOT);
    expect(doc).toContain("the user's personal agent");
    expect(doc).toContain('NEVER read, search, or list the memory directory directly');
    expect(doc).toContain('NEVER create, modify, rename, or delete anything under the memory root');
    expect(doc).toContain('Never fabricate memories');
    expect(doc).toContain('rendered verbatim in a web chat UI');
  });

  it('chat: lists exactly the six reader commands (no recall)', () => {
    const doc = renderPhaseSkillDoc('chat', ROOT);
    for (const cmd of SIX_READER_COMMANDS) {
      expect(doc).toContain(cmd);
    }
    expect(doc).not.toContain('recall "<query>"');
  });

  it('chat: points past-questions at a reader-only sub-agent following skills/recall.md', () => {
    const doc = renderPhaseSkillDoc('chat', ROOT);
    expect(doc).toContain('skills/recall.md');
    expect(doc).toContain('sub-agent equipped with ONLY the reader');
    expect(doc).toContain('POINTERS ONLY (slice ids + relevance)');
    expect(doc).toContain('readslice');
    // The degraded path: no sub-agent support / no recall skill file.
    expect(doc).toContain('do the same search yourself with the command list above');
  });

  it('housekeeping: lists exactly the three card-evolution reader commands (no recall)', () => {
    const doc = renderPhaseSkillDoc('housekeeping', ROOT);
    for (const cmd of THREE_HOUSEKEEPING_COMMANDS) {
      expect(doc).toContain(cmd);
    }
    // timeline / strands / slicesummary are no longer listed as tools.
    for (const cmd of HOUSEKEEPING_DENIED_COMMAND_LINES) {
      expect(doc).not.toContain(cmd);
    }
    expect(doc).not.toContain('recall "<query>"');
  });

  it('housekeeping: evidence reads are card-evolution forensics ONLY; denied commands are named', () => {
    const doc = renderPhaseSkillDoc('housekeeping', ROOT);
    expect(doc).toContain('card evolution');
    expect(doc).toContain('never read memory');
    // The refusal is stated explicitly, matching the hard reader gate.
    expect(doc).toContain('`timeline`, `strands`, and `slicesummary` are NOT available');
    expect(doc).toContain('refuses them (exit 1)');
    expect(doc).toContain('`card bootstrap` is refused');
  });

  it('housekeeping: keeps the read-only rules and defers the business spec to the task input', () => {
    const doc = renderPhaseSkillDoc('housekeeping', ROOT);
    expect(doc).toContain('NEVER read, search, or list the memory directory directly');
    expect(doc).toContain('NEVER write anything anywhere under the memory root');
    expect(doc).toContain('task input');
    expect(doc).toContain('source of truth');
  });

  it('housekeeping: no longer carries business-rule copies (they live in the kernel task text)', () => {
    const doc = renderPhaseSkillDoc('housekeeping', ROOT);
    for (const gone of [
      'memory_worthy',
      'emotional_signal',
      'closed_marking',
      'CardMutation',
      'addSelfModel',
      'strand_merges',
      'EXACTLY one JSON object',
    ]) {
      expect(doc).not.toContain(gone);
    }
  });
});
