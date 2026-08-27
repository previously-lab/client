import { afterEach, describe, expect, it } from 'vitest';
import {
  banner,
  bold,
  box,
  brand,
  cmdTable,
  colorSupported,
  err,
  heading,
  muted,
  ok,
  section,
  setColorEnabled,
  stringWidth,
  stripAnsi,
  styleDiff,
  styleHelp,
  truecolorSupported,
} from '../src/lib/ansi.js';

describe('ansi styling', () => {
  afterEach(() => {
    setColorEnabled(undefined);
  });

  describe('colorSupported', () => {
    it('is off for non-TTY streams', () => {
      expect(colorSupported({ isTTY: false }, {})).toBe(false);
      expect(colorSupported({}, {})).toBe(false);
    });

    it('is on for a TTY with a normal TERM', () => {
      expect(colorSupported({ isTTY: true }, { TERM: 'xterm-256color' })).toBe(true);
    });

    it('respects NO_COLOR', () => {
      expect(colorSupported({ isTTY: true }, { NO_COLOR: '', TERM: 'xterm' })).toBe(false);
    });

    it('respects FORCE_COLOR over NO_COLOR and non-TTY', () => {
      expect(colorSupported({ isTTY: false }, { FORCE_COLOR: '1', NO_COLOR: '' })).toBe(true);
      expect(colorSupported({ isTTY: true }, { FORCE_COLOR: '0', TERM: 'xterm' })).toBe(false);
    });

    it('treats TERM=dumb as no color', () => {
      expect(colorSupported({ isTTY: true }, { TERM: 'dumb' })).toBe(false);
    });
  });

  describe('truecolorSupported', () => {
    it('detects COLORTERM truecolor/24bit', () => {
      expect(truecolorSupported({ COLORTERM: 'truecolor' })).toBe(true);
      expect(truecolorSupported({ COLORTERM: '24bit' })).toBe(true);
      expect(truecolorSupported({})).toBe(false);
    });
  });

  describe('style wrappers', () => {
    it('return the plain string when styling is off', () => {
      setColorEnabled(false);
      expect(bold('hi')).toBe('hi');
      expect(brand('hi')).toBe('hi');
      expect(muted('hi')).toBe('hi');
    });

    it('wrap with escape codes when styling is on', () => {
      setColorEnabled(true);
      expect(bold('hi')).toBe('\x1b[1mhi\x1b[0m');
    });

    it('brand uses #0066FF truecolor when available', () => {
      setColorEnabled(true);
      const prev = process.env.COLORTERM;
      process.env.COLORTERM = 'truecolor';
      try {
        expect(brand('hi')).toBe('\x1b[38;2;0;102;255mhi\x1b[0m');
      } finally {
        if (prev === undefined) delete process.env.COLORTERM;
        else process.env.COLORTERM = prev;
      }
    });

    it('brand falls back to ANSI blue without truecolor', () => {
      setColorEnabled(true);
      const prev = process.env.COLORTERM;
      delete process.env.COLORTERM;
      try {
        expect(brand('hi')).toBe('\x1b[34mhi\x1b[0m');
      } finally {
        if (prev !== undefined) process.env.COLORTERM = prev;
      }
    });
  });

  describe('semantic wrappers', () => {
    it('add symbols and color when on', () => {
      setColorEnabled(true);
      expect(ok('done')).toBe('\x1b[32m✓ done\x1b[0m');
      expect(err('failed')).toBe('\x1b[31m✗ failed\x1b[0m');
      expect(heading('Title')).toContain('Title');
      expect(heading('Title')).toContain('\x1b[');
    });

    it('keep the exact original text when off', () => {
      setColorEnabled(false);
      expect(ok('done')).toBe('done');
      expect(err('failed')).toBe('failed');
      expect(heading('Title')).toBe('Title');
    });
  });

  describe('styleHelp', () => {
    const help = 'mycli — does things\n\nCommands:\n  start     Start it\n              more detail here\n  --force   Force it';

    it('returns the input untouched when styling is off', () => {
      setColorEnabled(false);
      expect(styleHelp(help)).toBe(help);
    });

    it('styles title, headers and command tokens, not continuation lines', () => {
      setColorEnabled(true);
      const styled = styleHelp(help);
      const lines = styled.split('\n');
      expect(lines[0]).toContain('\x1b[');
      expect(lines[2]).toBe('\x1b[1mCommands:\x1b[0m');
      expect(lines[3]).toContain('\x1b[1mstart\x1b[0m');
      expect(lines[4]).toBe('              more detail here');
      expect(lines[5]).toContain('\x1b[1m--force\x1b[0m');
    });
  });

  describe('styleDiff', () => {
    it('colors + and - lines when on, untouched when off', () => {
      const diff = '  ctx\n- old\n+ new';
      setColorEnabled(false);
      expect(styleDiff(diff)).toBe(diff);
      setColorEnabled(true);
      expect(styleDiff(diff)).toBe(`  ctx\n\x1b[31m- old\x1b[0m\n\x1b[32m+ new\x1b[0m`);
    });
  });

  describe('stringWidth', () => {
    it('counts ASCII as 1, CJK as 2, ignores ANSI codes', () => {
      expect(stringWidth('abc')).toBe(3);
      expect(stringWidth('前情提要')).toBe(8);
      expect(stringWidth('\x1b[1mab\x1b[0m')).toBe(2);
    });
  });

  describe('box', () => {
    it('returns plain lines (title first) when styling is off', () => {
      setColorEnabled(false);
      expect(box(['a', 'b'], { title: 'T' })).toEqual(['T', '', 'a', 'b']);
      expect(box(['a'])).toEqual(['a']);
    });

    it('draws an aligned rounded card when styling is on', () => {
      setColorEnabled(true);
      const out = box(['Service:   ok', '前情提要 ready'], { title: 'Previously' }).map(stripAnsi);
      expect(out[0]).toMatch(/^╭─ Previously ─+╮$/);
      expect(out[out.length - 1]).toMatch(/^╰─+╯$/);
      // Every visible row has the same cell width.
      const widths = out.map(stringWidth);
      expect(new Set(widths).size).toBe(1);
      // Content survives intact inside the borders.
      expect(out[1]).toContain('Service:   ok');
      expect(out[2]).toContain('前情提要 ready');
    });

    it('pad adds blank lines inside the edges; tone recolors the border', () => {
      setColorEnabled(true);
      const padded = box(['x'], { pad: true }).map(stripAnsi);
      expect(padded[1]).toMatch(/^│\s+│$/);
      expect(padded[padded.length - 2]).toMatch(/^│\s+│$/);
      expect(box(['x'], { tone: 'green' })[0]).toContain('\x1b[32m');
      // Off: padding is dropped.
      setColorEnabled(false);
      expect(box(['x'], { pad: true })).toEqual(['x']);
    });
  });

  describe('banner', () => {
    it('is empty when styling is off, a padded card when on', () => {
      setColorEnabled(false);
      expect(banner('T', 'sub')).toEqual([]);
      setColorEnabled(true);
      const out = banner('Previously', 'tagline').map(stripAnsi);
      expect(out[0]).toMatch(/^╭─+╮$/);
      expect(out.some((l) => l.includes('Previously'))).toBe(true);
      expect(out.some((l) => l.includes('tagline'))).toBe(true);
      expect(new Set(out.map(stringWidth)).size).toBe(1);
    });
  });

  describe('cmdTable', () => {
    const entries: [string, string][] = [
      ['previously start', 'start it'],
      ['previously install --all', 'install everything'],
    ];

    it('plain two-column layout when styling is off', () => {
      setColorEnabled(false);
      expect(cmdTable(entries)).toEqual([
        '  previously start            start it',
        '  previously install --all    install everything',
      ]);
    });

    it('adds a $ glyph and keeps columns aligned when on', () => {
      setColorEnabled(true);
      const out = cmdTable(entries).map(stripAnsi);
      expect(out[0]).toBe('  $ previously start          start it');
      expect(out[1]).toBe('  $ previously install --all  install everything');
    });
  });

  describe('section', () => {
    it('prefixes a diamond glyph when on, plain label when off', () => {
      setColorEnabled(false);
      expect(section('Setup')).toBe('Setup');
      setColorEnabled(true);
      expect(stripAnsi(section('Setup'))).toBe('◆ Setup');
    });
  });
});
