import { describe, expect, it } from 'vitest';
import { renderPhaseSkillDoc } from '../src/lib/phase-skills.js';
import { MEMORY_ROOT_PLACEHOLDER } from '../src/lib/skills.js';

const ROOT = 'C:\\mem\\root';

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
      expect(doc).toContain('previously recall');
      const prefixed = renderPhaseSkillDoc(phase, ROOT, '"node" "C:\\x\\cli.js"');
      expect(prefixed).toContain('"node" "C:\\x\\cli.js" recall');
      expect(prefixed).not.toContain('{{PREVIOUSLY_CMD}}');
    }
  });

  it('chat: states the constrained tool contract and the verbatim-reply output contract', () => {
    const doc = renderPhaseSkillDoc('chat', ROOT);
    expect(doc).toContain('previously recall "<query>"');
    expect(doc).toContain('previously readslice <sliceId>');
    expect(doc).toContain('POINTERS ONLY');
    expect(doc).toContain('NEVER read, search, or list the memory directory directly');
    expect(doc).toContain('NEVER create, modify, rename, or delete anything under the memory root');
    expect(doc).toContain('rendered verbatim in a web chat UI');
  });

  it('chat: lists the full seven-command memory tool set', () => {
    const doc = renderPhaseSkillDoc('chat', ROOT);
    for (const cmd of [
      'previously recall "<query>"',
      'previously readslice <sliceId> [--start N --end N]',
      'previously timeline [--month YYYY-MM] [--day MM-DD]',
      'previously strands [name]',
      'previously card [--slice <sliceId>]',
      'previously slicesummary <sliceId>',
      'previously agentlog <sliceId> [--start N --end N]',
    ]) {
      expect(doc).toContain(cmd);
    }
  });

  it('chat: never mentions native capabilities (web search / thinkDeep)', () => {
    const doc = renderPhaseSkillDoc('chat', ROOT).toLowerCase();
    expect(doc).not.toContain('web search');
    expect(doc).not.toContain('websearch');
    expect(doc).not.toContain('thinkdeep');
    expect(doc).not.toContain('deep reasoning');
  });

  it('chat: states the recall protocol, including the sub-agent guidance', () => {
    const doc = renderPhaseSkillDoc('chat', ROOT);
    expect(doc).toContain('recall protocol');
    expect(doc).toContain('POINTERS, not content');
    expect(doc).toContain('ONE recall, then stop');
    expect(doc).toContain('the index, not the archive');
    expect(doc).toContain('sub-agent equipped with ONLY these memory commands');
    expect(doc).toContain("If it\n  can't, follow the same steps yourself");
  });

  it('housekeeping: lists the full seven-command evidence tool set', () => {
    const doc = renderPhaseSkillDoc('housekeeping', ROOT);
    for (const cmd of [
      'previously recall "<query>"',
      'previously readslice <sliceId> [--start N --end N]',
      'previously timeline [--month YYYY-MM] [--day MM-DD]',
      'previously strands [name]',
      'previously card [--slice <sliceId>]',
      'previously slicesummary <sliceId>',
      'previously agentlog <sliceId> [--start N --end N]',
    ]) {
      expect(doc).toContain(cmd);
    }
  });

  it('housekeeping: states the analysis rules, gating bias, and evidence discipline', () => {
    const doc = renderPhaseSkillDoc('housekeeping', ROOT);
    expect(doc).toContain('memory_worthy');
    expect(doc).toContain('memory_update');
    expect(doc).toContain('emotional_signal');
    expect(doc).toContain('closed_marking');
    expect(doc).toContain('a wasted review is cheap');
    expect(doc).toContain('previously recall "<query>"');
    expect(doc).toContain('NEVER write anything anywhere under the memory root');
  });

  it('housekeeping: pins the CardMutation vocabulary and the JSON output contract', () => {
    const doc = renderPhaseSkillDoc('housekeeping', ROOT);
    for (const op of [
      'setIdentity',
      'updatePastProfile',
      'addPastAnchor',
      'removePastAnchor',
      'addNow',
      'removeNow',
      'promoteNowToPast',
      'addHorizon',
      'resolveHorizon',
      'addSelfModel',
      'removeSelfModel',
    ]) {
      expect(doc).toContain(`"op": "${op}"`);
    }
    expect(doc).toContain('EXACTLY one JSON object');
    expect(doc).toContain('"analysis"');
    expect(doc).toContain('"evolution"');
    expect(doc).toContain('"mutations": CardMutation[]');
  });

  it('housekeeping: pins the strand_merges contract and its precision rules', () => {
    const doc = renderPhaseSkillDoc('housekeeping', ROOT);
    expect(doc).toContain('"strand_merges"');
    expect(doc).toContain('Strand merge candidates');
    expect(doc).toContain('copied verbatim from the offered list');
    expect(doc).toContain('No chains');
    expect(doc).toContain('When in doubt, do NOT merge');
  });
});
