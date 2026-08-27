/**
 * Hand-rolled ANSI styling — keeps the zero-runtime-deps policy intact.
 *
 * Every decorative change in the CLI funnels through here. Styling is
 * enabled only when a human is looking at the output (TTY, no NO_COLOR,
 * TERM !== 'dumb'); piped/scripted output stays byte-identical plain text,
 * and symbols (✓/✗/!) are gated on the same switch. Tests either run with
 * styling off (vitest captures are not TTYs) or drive the pure primitives
 * below directly.
 */
export interface TTYStream {
  isTTY?: boolean;
}

/** Standard color support probe: FORCE_COLOR > NO_COLOR > TTY > TERM. */
export function colorSupported(stream: TTYStream, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0';
  if (env.NO_COLOR !== undefined) return false;
  if (!stream.isTTY) return false;
  return env.TERM !== 'dumb';
}

/** Truecolor (24-bit) probe for the brand color; falls back to ANSI blue. */
export function truecolorSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit';
}

let enabled: boolean | undefined;

function isEnabled(): boolean {
  if (enabled === undefined) enabled = colorSupported(process.stdout);
  return enabled;
}

/** Whether styled output (colors, symbols, cards) is active right now. */
export function stylingOn(): boolean {
  return isEnabled();
}

/** Test hook: force styling on/off, or pass undefined to re-detect. */
export function setColorEnabled(value: boolean | undefined): void {
  enabled = value;
}

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

function style(code: string, s: string): string {
  return isEnabled() ? `${ESC}${code}m${s}${RESET}` : s;
}

export const bold = (s: string): string => style('1', s);
export const dim = (s: string): string => style('2', s);
export const red = (s: string): string => style('31', s);
export const green = (s: string): string => style('32', s);
export const yellow = (s: string): string => style('33', s);
export const cyan = (s: string): string => style('36', s);
export const gray = (s: string): string => style('90', s);

/** Brand color #0066FF (the web theme color); ANSI blue without truecolor. */
export function brand(s: string): string {
  return style(truecolorSupported() ? '38;2;0;102;255' : '34', s);
}

// Semantic wrappers — these add a symbol prefix only when styling is on,
// so piped output keeps its exact original text.
export const ok = (s: string): string => (isEnabled() ? green(`✓ ${s}`) : s);
export const err = (s: string): string => (isEnabled() ? red(`✗ ${s}`) : s);
export const warn = (s: string): string => (isEnabled() ? yellow(`! ${s}`) : s);
export const info = (s: string): string => (isEnabled() ? brand(`i ${s}`) : s);

/** Headings and emphasis anchors: brand-colored. */
export const heading = (s: string): string => brand(bold(s));
export const cmd = (s: string): string => brand(s);
export const emph = (s: string): string => brand(s);
export const muted = (s: string): string => gray(s);

/**
 * Style a multi-line usage/help block: brand-colored title (first line),
 * bold section headers (unindented lines ending in ':'), bold leading token
 * of indented lines (command/flag names). Returns the input untouched when
 * styling is off, so piped --help stays byte-stable plain text.
 */
export function styleHelp(text: string): string {
  if (!isEnabled()) return text;
  return text
    .split('\n')
    .map((line, i) => {
      if (i === 0) return heading(line);
      if (line.startsWith('Usage:')) return bold('Usage:') + line.slice('Usage:'.length);
      if (/^\S[^:]*:$/.test(line)) return bold(line);
      const m = line.match(/^(\s+)(\S+)/);
      // Command entries sit at 2-space indent; deeper indents are prose
      // continuation lines — except sub-flag rows, which start with '--'.
      if (m !== null && (m[1]!.length === 2 || m[2]!.startsWith('--')) && !m[2]!.startsWith('(')) {
        return `${m[1]}${bold(m[2]!)}${line.slice(m[1]!.length + m[2]!.length)}`;
      }
      return line;
    })
    .join('\n');
}

/**
 * Color a line-based diff (lib/diff.ts output): '+ ' lines green, '- ' lines
 * red, context lines untouched. Returns the input untouched when styling is
 * off.
 */
export function styleDiff(diff: string): string {
  if (!isEnabled()) return diff;
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+ ')) return green(line);
      if (line.startsWith('- ')) return red(line);
      return line;
    })
    .join('\n');
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Remove ANSI SGR escape codes. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// East Asian wide/fullwidth ranges + emoji — these occupy 2 terminal cells.
const WIDE_RE =
  /[ᄀ-ᅟ⺀-鿏ꥠ-꥿가-힯豈-﫿︰-﹯＀-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}]/u;

/** Display width in terminal cells (ANSI-aware, CJK/emoji count as 2). */
export function stringWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += WIDE_RE.test(ch) ? 2 : 1;
  return w;
}

/**
 * Render lines inside a rounded "card" with a colored border and an
 * optional title embedded in the top edge:
 *
 *   ╭─ Title ──────────╮
 *   │  content line    │
 *   ╰──────────────────╯
 *
 * Options:
 *   title   embedded in the top border
 *   tone    border color: brand (default), green for success, red, yellow
 *   pad     breathe: one blank line just inside the top and bottom edges
 *
 * When styling is off the card dissolves back to the plain lines (with the
 * title as a plain first line followed by a blank line, padding dropped), so
 * piped output stays byte-stable.
 */
export interface BoxOptions {
  title?: string;
  tone?: 'brand' | 'green' | 'red' | 'yellow';
  pad?: boolean;
}

export function box(lines: string[], opts: BoxOptions = {}): string[] {
  const { title, tone = 'brand', pad = false } = opts;
  if (!isEnabled()) return title !== undefined ? [title, '', ...lines] : lines;

  const border = tone === 'green' ? green : tone === 'red' ? red : tone === 'yellow' ? yellow : brand;
  const body = pad ? ['', ...lines, ''] : lines;

  const titleWidth = title !== undefined ? stringWidth(title) : 0;
  const contentWidth = Math.max(titleWidth + 2, ...body.map((l) => stringWidth(l)));
  const padLine = (l: string): string => ' '.repeat(contentWidth - stringWidth(l));

  const top =
    title !== undefined
      ? border('╭─ ') + heading(title) + border(' ' + '─'.repeat(contentWidth - titleWidth - 1) + '╮')
      : border('╭' + '─'.repeat(contentWidth + 2) + '╮');
  const bottom = border('╰' + '─'.repeat(contentWidth + 2) + '╯');
  const rows = body.map((l) => border('│') + ' ' + l + padLine(l) + ' ' + border('│'));
  return [top, ...rows, bottom];
}

/**
 * Print a card via one console.log per line. When styling is off the card
 * dissolves to the plain lines (see box()), so the printed call sequence —
 * and the piped output — is byte-identical to unstyled code that logs each
 * line separately. Tests that spy on console.log rely on this.
 */
export function printBoxed(lines: string[], opts: BoxOptions = {}): void {
  for (const line of box(lines, opts)) console.log(line);
}

/**
 * Brand banner — the Vue CLI / Nuxt-style welcome panel:
 *
 *   ╭──────────────────────────────╮
 *   │                              │
 *   │   Previously                 │
 *   │   local long-term memory     │
 *   │                              │
 *   ╰──────────────────────────────╯
 *
 * Returns [] when styling is off — callers print their plain header text
 * themselves in that case.
 */
export function banner(title: string, subtitle?: string): string[] {
  if (!isEnabled()) return [];
  const lines = [`  ${heading(title)}`];
  if (subtitle !== undefined) lines.push(`  ${muted(subtitle)}`);
  return box(lines, { pad: true });
}

/**
 * Command table with a `$` prompt glyph, aligned columns — the
 * "get started with these commands" block Vue/Next CLIs print:
 *
 *   $ previously start     start the kernel + scribe
 *   $ previously open      open the Web UI
 *
 * When styling is off the `$` glyph drops out and the plain form is
 * `  <cmd padded>  <desc>` — matching the classic two-column layout.
 */
export function cmdTable(entries: [string, string][], padTo?: number): string[] {
  const width = padTo ?? Math.max(...entries.map(([c]) => stringWidth(c)));
  if (!isEnabled()) return entries.map(([c, d]) => `  ${c.padEnd(width + 4)}${d}`);
  return entries.map(
    ([c, d]) => `  ${brand('$')} ${bold(c)}${' '.repeat(width - stringWidth(c))}  ${muted(d)}`,
  );
}

/**
 * Section header with a brand diamond glyph (`◆ Setup`), clack-style.
 * Plain form (styling off) is just the label.
 */
export function section(label: string): string {
  return isEnabled() ? `${brand('◆')} ${bold(label)}` : label;
}
