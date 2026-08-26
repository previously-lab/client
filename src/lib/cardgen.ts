import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { writeFileAtomic } from './atomic.js';
import { backupOnce } from './skills.js';
import { parseSliceId, sliceIdToRelDir } from './slices.js';
import type { ScribeIndexEntry } from '../scribe/slicer.js';

/**
 * Previously card bootstrap (`previously card bootstrap`): build the first
 * 前情提要 (current-previously.md) after a history ingest.
 *
 * Spend discipline: ingested historical slices NEVER trigger card evolution
 * one by one — that would replay years of "Now" at full token cost for no
 * present-day meaning. Instead the caller picks a scope:
 * - `--empty`   zero model calls: write the empty card skeleton, start fresh.
 * - window mode (default 7d): ONE model call over the most recent window.
 * - `--full`    ONE model call over the whole archived history (index-level
 *               data only). Requires --yes after seeing the estimate.
 */

export const CARD_TOTAL_CAP = 12_000;
const CONTEXT_CAP = 12_000;
const DRY_FIRST_LINE_CAP = 120;

export function emptyCard(): string {
  return `# Previously On

_Format: user card v2 | Updated: ${new Date().toISOString()}_

## Identity

## Past

## Now

## Horizon

## Self-model
`;
}

export interface CardScopeEntry {
  sliceId: string;
  start: string;
  source: string;
  tags: string[];
  /** focus/summary when marked, else a deterministic first-line fallback. */
  line: string;
  marked: boolean;
}

function firstUserLine(core: string): string {
  const match = /^## Turn \S+ — \S+ \(user\)\s*\n+([^\n]+)/m.exec(core);
  const line = (match?.[1] ?? '').replace(/\s+/g, ' ').trim();
  return line.length > DRY_FIRST_LINE_CAP ? `${line.slice(0, DRY_FIRST_LINE_CAP)}…` : line;
}

/**
 * Collect the card-generation context from monthly manifests. `sinceMs`
 * (epoch ms) limits to slices started at/after it; null = whole history.
 * Dry slices contribute a first-user-line fallback (no model call spent on
 * them here). The result is capped, keeping the MOST RECENT entries.
 */
export function collectCardContext(
  memoryRoot: string,
  sinceMs: number | null,
): { entries: CardScopeEntry[]; totalSlices: number } {
  const slicesRoot = join(memoryRoot, 'episodic', 'slices');
  const all: CardScopeEntry[] = [];
  if (existsSync(slicesRoot)) {
    for (const y of readdirSync(slicesRoot)) {
      if (!/^\d{4}$/.test(y)) continue;
      let months: string[];
      try {
        months = readdirSync(join(slicesRoot, y));
      } catch {
        continue;
      }
      for (const m of months) {
        const indexPath = join(slicesRoot, y, m, '_index.json');
        if (!existsSync(indexPath)) continue;
        let parsed: { slices?: ScribeIndexEntry[] };
        try {
          parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as { slices?: ScribeIndexEntry[] };
        } catch {
          continue;
        }
        for (const entry of parsed.slices ?? []) {
          if (sinceMs !== null && Date.parse(entry.start) < sinceMs) continue;
          const marked = entry.focus !== '' || entry.summary !== '';
          let line = [entry.focus, entry.summary].filter((s) => s !== '').join(' — ');
          if (!marked) {
            const parts = parseSliceId(entry.id);
            if (parts !== null) {
              const corePath = join(
                slicesRoot,
                ...sliceIdToRelDir(parts).split('/'),
                'timeline',
                'core.md',
              );
              if (existsSync(corePath)) line = firstUserLine(readFileSync(corePath, 'utf8'));
            }
          }
          if (line === '') continue;
          all.push({ sliceId: entry.id, start: entry.start, source: entry.source, tags: entry.tags, line, marked });
        }
      }
    }
  }
  all.sort((a, b) => a.start.localeCompare(b.start));

  // Cap the context, keeping the most recent entries.
  const kept: CardScopeEntry[] = [];
  let chars = 0;
  for (const entry of [...all].reverse()) {
    const lineChars = entry.line.length + 40;
    if (chars + lineChars > CONTEXT_CAP && kept.length > 0) break;
    kept.push(entry);
    chars += lineChars;
  }
  return { entries: kept.reverse(), totalSlices: all.length };
}

export function formatCardContext(entries: CardScopeEntry[]): string {
  return entries
    .map((e) => `- **${e.sliceId}** (${e.source})${e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : ''} ${e.line}`)
    .join('\n');
}

/** The card-generation task prompt; the formatted context goes in `context`. */
export const CARD_BOOTSTRAP_TASK = `You are bootstrapping the "Previously On" card — the living summary a personal memory assistant keeps about its user. The context lists past conversation time slices (id, source, tags, focus/summary or a first-line fallback).

Write the card as EXACTLY this markdown structure — no other text, no fences:

# Previously On

## Identity
- Name / how to address them / stable facts (≤8 lines, only when evidenced)

## Past
<one rolling profile paragraph, ≤2400 chars>
- <durable anchor fact, ≤300 chars each, at most 8> — refs: [YYYY/MM/DD/HHMM of the evidence slice]

## Now
- <current threads/events, ≤300 chars each, at most 5> — refs: [...] | since: YYYY-MM-DD

## Horizon
- <future commitments / deadlines / awaited replies, ≤200 chars each, at most 5> — by: YYYY-MM-DD or null — refs: [...]

## Self-model
- <operating lessons about how to work with this user, ≤300 chars each, at most 10> — refs: [...]

Rules:
- Every bullet needs refs pointing at the slice ids it came from (convert YYYY-MM-DD-HHMM to YYYY/MM/DD/HHMM). No evidence, no entry.
- Only include what the slices actually support; empty sections are fine (leave just the header).
- The slice data is the whole truth available to you — never invent facts.
- Output ONLY the card markdown.`;

export interface CardValidation {
  card: string | null;
  error: string | null;
}

const REQUIRED_SECTIONS = ['## Identity', '## Past', '## Now', '## Horizon', '## Self-model'];

/** Validate the model's reply as a card document; normalize when possible. */
export function validateCardDocument(text: string): CardValidation {
  let card = text.trim();
  // Tolerate a single whole-reply fence.
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(card);
  if (fence !== null) card = fence[1]!.trim();
  if (!card.startsWith('# Previously On')) {
    return { card: null, error: 'reply does not start with "# Previously On"' };
  }
  for (const section of REQUIRED_SECTIONS) {
    if (!card.includes(`\n${section}`)) {
      return { card: null, error: `reply is missing the required section "${section}"` };
    }
  }
  if (card.length > CARD_TOTAL_CAP) {
    return { card: null, error: `card exceeds the ${CARD_TOTAL_CAP}-char cap (${card.length} chars)` };
  }
  // Normalize the meta line: the kernel owns Active slice; we stamp Updated.
  const lines = card.split('\n');
  const metaIdx = lines.findIndex((l) => l.startsWith('_') && l.endsWith('_'));
  const meta = `_Format: user card v2 | Updated: ${new Date().toISOString()}_`;
  if (metaIdx >= 0 && metaIdx < 4) lines[metaIdx] = meta;
  else lines.splice(1, 0, '', meta);
  return { card: lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n', error: null };
}

/** Write the live card (one-time .bak backup first). */
export function writeLiveCard(memoryRoot: string, card: string, force: boolean): { path: string; backupPath: string | null } {
  const path = join(memoryRoot, 'episodic', 'current-previously.md');
  if (existsSync(path) && !force) {
    const existing = readFileSync(path, 'utf8');
    if (existing.trim() !== '' && !existing.includes('## Identity\n\n## Past')) {
      throw new Error(`A live card already exists at ${path} (pass --force to overwrite).`);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const backupPath = backupOnce(path);
  writeFileAtomic(path, card);
  return { path, backupPath };
}
