/**
 * Minimal line-based diff for `previously install/uninstall --dry-run`.
 * LCS over lines — config files are small, so the O(n·m) table is fine and
 * keeps the zero-runtime-deps policy intact.
 */
export function diffLines(oldText: string, newText: string): string {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // LCS length table.
  const m = a.length;
  const n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < m) out.push(`- ${a[i++]}`);
  while (j < n) out.push(`+ ${b[j++]}`);
  return out.join('\n');
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  // Drop the trailing empty element a final newline produces.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
