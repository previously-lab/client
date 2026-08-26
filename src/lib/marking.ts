import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { parseSliceId, sliceIdToRelDir } from './slices.js';
import { yamlScalar } from '../scribe/slicer.js';
import type { ScribeIndexEntry } from '../scribe/slicer.js';

/**
 * Eager semantic marking for dry slices (`previously ingest --mark`): fills
 * focus / summary / tags by asking the configured bridge brain, ONE model call
 * per slice. This is the opt-in, token-spending counterpart of the kernel's
 * built-in backfill-marks (which only fills focus/summary, lazily, at slice
 * close boundaries) — ours also extracts tags, and runs on demand.
 *
 * Spend discipline: the command layer estimates the batch (N dry slices = N
 * model calls) and refuses to run without an explicit --yes. One confirmation
 * covers one batch; a later batch asks again.
 */

export interface DrySliceRef {
  sliceId: string;
  start: string;
  source: string;
  sessionId: string;
}

/** All monthly-manifest entries with both focus and summary empty. */
export function findDrySlices(memoryRoot: string): DrySliceRef[] {
  const slicesRoot = join(memoryRoot, 'episodic', 'slices');
  const out: DrySliceRef[] = [];
  if (!existsSync(slicesRoot)) return out;
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
        if (entry.focus === '' && entry.summary === '') {
          out.push({
            sliceId: entry.id,
            start: entry.start,
            source: entry.source,
            sessionId: entry.sessionId,
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.sliceId.localeCompare(b.sliceId));
}

const TURN_HEADER = /^## Turn (\S+) — (\S+) \((user|agent)\)\s*$/;

interface TurnRef {
  role: string;
  timestamp: string;
  body: string;
}

function parseTurns(core: string): TurnRef[] {
  const turns: TurnRef[] = [];
  let current: TurnRef | null = null;
  let bodyLines: string[] = [];
  const flush = (): void => {
    if (current === null) return;
    turns.push({ ...current, body: bodyLines.join('\n').trim() });
    current = null;
    bodyLines = [];
  };
  for (const line of core.split(/\r?\n/)) {
    const header = TURN_HEADER.exec(line);
    if (header !== null) {
      flush();
      current = { role: header[3]!, timestamp: header[2]!, body: '' };
    } else if (current !== null) {
      bodyLines.push(line);
    }
  }
  flush();
  return turns;
}

const PER_TURN_CAP = 300;
const TOTAL_CAP = 6000;

/**
 * Compress a slice for the marking prompt: first turn + last 10 turns, each
 * truncated, whole thing capped (mirrors the kernel's backfill-marks
 * compressTurns budget).
 */
export function compressSliceForMarking(core: string): string {
  const turns = parseTurns(core);
  if (turns.length === 0) return '(no parseable turns)';
  const picked = turns.length <= 11 ? turns : [turns[0]!, ...turns.slice(-10)];
  const omitted = turns.length - picked.length;
  const parts = picked.map((turn) => {
    const body = turn.body.length > PER_TURN_CAP ? `${turn.body.slice(0, PER_TURN_CAP)}…` : turn.body;
    return `[${turn.role} ${turn.timestamp}]\n${body}`;
  });
  let text = omitted > 0 ? `(${omitted} middle turns omitted)\n\n${parts.join('\n\n')}` : parts.join('\n\n');
  if (text.length > TOTAL_CAP) text = `${text.slice(0, TOTAL_CAP)}…`;
  return text;
}

/** The marking task prompt (bridge dispatch `task`; the compressed slice goes
 *  in `context`). Output contract: exactly one JSON object, no fences. */
export const MARKING_TASK = `A past conversation time slice is archived without a summary. Read the compressed conversation in the context and produce its mark.

Reply with EXACTLY one JSON object — no markdown fences, no prose before or after:
{"focus": "<one line: what the session was about>", "summary": "<=100 characters: what happened / key decisions>", "tags": ["<2-6 durable topic strands; reuse generic names, never one-off events>"]}`;

export interface SliceMark {
  focus: string;
  summary: string;
  tags: string[];
}

/** Parse the model's reply into a mark. Throws on anything unrecognizable —
 *  the caller records a per-slice failure and moves on (best-effort batch). */
export function parseMarkingResponse(text: string): SliceMark {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('reply contained no JSON object');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error(`reply JSON did not parse: ${text.slice(start, start + 120)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('reply JSON is not an object');
  }
  const rec = parsed as Record<string, unknown>;
  const focus = typeof rec.focus === 'string' ? rec.focus.trim() : '';
  let summary = typeof rec.summary === 'string' ? rec.summary.trim().replace(/\s+/g, ' ') : '';
  if (summary.length > 100) summary = `${summary.slice(0, 99)}…`;
  const tags = Array.isArray(rec.tags)
    ? rec.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()).slice(0, 6)
    : [];
  if (focus === '' && summary === '') {
    throw new Error('reply had neither focus nor summary');
  }
  return { focus, summary, tags };
}

export interface ApplyMarkResult {
  /** Frontmatter keys we could not safely patch (block scalars etc.). */
  skippedKeys: string[];
}

function sliceCorePath(memoryRoot: string, sliceId: string): string {
  const parts = parseSliceId(sliceId);
  if (parts === null || parts.hm === undefined) throw new Error(`Invalid slice id: ${sliceId}`);
  return join(memoryRoot, 'episodic', 'slices', ...sliceIdToRelDir(parts).split('/'), 'timeline', 'core.md');
}

/**
 * Patch focus/summary/tags into a slice's frontmatter. Conservative,
 * line-based: a key present as a block scalar (`key: >-`) is left untouched
 * and reported in skippedKeys — we never rewrite YAML we don't fully
 * understand. Unknown content outside those three keys is preserved byte-wise.
 */
export function patchSliceFrontmatter(core: string, mark: SliceMark): { patched: string; skippedKeys: string[] } {
  const lines = core.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('slice has no frontmatter block');
  const fmEnd = lines.indexOf('---', 1);
  if (fmEnd < 0) throw new Error('slice frontmatter is unterminated');

  const wanted: Array<[string, string]> = [
    ['focus', mark.focus],
    ['summary', mark.summary],
    ['tags', `[${mark.tags.map((t) => yamlScalar(t)).join(', ')}]`],
  ];
  const skippedKeys: string[] = [];
  const pending = new Map<string, string>();
  for (const [key, value] of wanted) {
    if (key === 'tags' || value !== '') pending.set(key, key === 'tags' ? value : yamlScalar(value));
  }

  const out: string[] = [];
  let i = 0;
  while (i <= fmEnd) {
    const line = lines[i]!;
    const keyMatch = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    const key = keyMatch?.[1];
    if (key !== undefined && pending.has(key)) {
      const valuePart = line.slice(line.indexOf(':') + 1).trim();
      if (valuePart === '>-' || valuePart === '|' || valuePart === '|-' || valuePart === '>') {
        skippedKeys.push(key);
        pending.delete(key);
      } else if (!(key === 'tags' && mark.tags.length === 0 && valuePart !== '[]')) {
        // Replace the single-line value. (Empty tags never clear a non-empty list.)
        out.push(`${key}: ${pending.get(key)!}`);
        pending.delete(key);
        i++;
        continue;
      } else {
        pending.delete(key);
      }
    }
    out.push(line);
    i++;
  }
  // Keys that never appeared: insert before the closing ---, keeping the
  // canonical field order as much as possible (focus after slice_id, summary
  // before open_loops, tags where it lands — order is cosmetic).
  const closing = out.lastIndexOf('---');
  const inserts: string[] = [];
  for (const [key, value] of pending) inserts.push(`${key}: ${value}`);
  out.splice(closing, 0, ...inserts);
  // The loop above only covered the frontmatter (lines[0..fmEnd]); the turn
  // body after the closing --- rides along untouched, byte-for-byte.
  out.push(...lines.slice(fmEnd + 1));
  return { patched: out.join('\n'), skippedKeys };
}

/** Apply a mark to core.md + the monthly manifest entry. */
export function applyMark(memoryRoot: string, sliceId: string, mark: SliceMark): ApplyMarkResult {
  const corePath = sliceCorePath(memoryRoot, sliceId);
  const core = readFileSync(corePath, 'utf8');
  const { patched, skippedKeys } = patchSliceFrontmatter(core, mark);
  if (patched !== core) writeFileAtomic(corePath, patched);

  const parts = parseSliceId(sliceId)!;
  const indexPath = join(memoryRoot, 'episodic', 'slices', parts.y, parts.m, '_index.json');
  if (existsSync(indexPath)) {
    const raw = readFileSync(indexPath, 'utf8');
    const parsed = JSON.parse(raw) as { month: string; slices: ScribeIndexEntry[] };
    const entry = parsed.slices.find((e) => e.id === sliceId);
    if (entry !== undefined) {
      if (mark.focus !== '') entry.focus = mark.focus;
      if (mark.summary !== '') entry.summary = mark.summary;
      if (mark.tags.length > 0 && entry.tags.length === 0) entry.tags = mark.tags;
      const json = JSON.stringify(parsed, null, 2) + '\n';
      if (json !== raw) writeFileAtomic(indexPath, json);
    }
  }
  return { skippedKeys };
}
