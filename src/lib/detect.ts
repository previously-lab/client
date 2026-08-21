import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Environment detection (agent CLIs, history dirs, API-key env vars).
 *
 * Everything here is a pure function of its inputs — env map, PATH string,
 * home dir, platform — so tests exercise the real logic against temp dirs
 * and fixture executables without touching the developer's machine.
 */

/** Agent CLIs probed for (gemini is scribe-only, not a bridge). */
export const AGENT_CLIS = ['claude', 'codex', 'kimi', 'gemini'] as const;
export type AgentCli = (typeof AGENT_CLIS)[number];

/** API-key env vars recognized as brain credentials, in display order. */
export const KNOWN_API_KEY_ENVS = [
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
] as const;

/** History roots the scribe reads from, keyed by agent CLI name. */
export const HISTORY_DIRS: Record<AgentCli, string> = {
  claude: '.claude',
  codex: '.codex',
  kimi: '.kimi-code',
  gemini: '.gemini',
};

export interface ScanOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** PATH string to search; defaults to env.PATH. */
  pathEnv?: string;
  platform?: NodeJS.Platform;
}

export interface CliDetection {
  name: AgentCli;
  found: boolean;
  /** Resolved executable path when found. */
  path: string | null;
}

export interface HistoryDirDetection {
  name: AgentCli;
  dir: string;
  present: boolean;
}

export interface ApiKeyDetection {
  env: string;
  /** Display-safe masked value, e.g. `sk-…3f2a`. Never the raw key. */
  masked: string;
}

export interface EnvironmentScan {
  clis: CliDetection[];
  historyDirs: HistoryDirDetection[];
  apiKeys: ApiKeyDetection[];
}

/**
 * Locate `command` on a PATH string. Checks the bare name plus the Windows
 * script extensions; directories that cannot be read are skipped quietly.
 */
export function findOnPath(
  command: string,
  { pathEnv = process.env.PATH ?? '', platform = process.platform }: { pathEnv?: string; platform?: NodeJS.Platform } = {},
): string | null {
  // An explicit path (fixture override like `node /x/cli.js` is resolved
  // earlier by the bridge; here a path-like value is checked directly).
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? command : null;
  }
  const exts = platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Mask a secret for display: `sk-…3f2a`. Short values reveal almost nothing. */
export function maskSecret(value: string): string {
  if (value.length > 8) return `${value.slice(0, 3)}…${value.slice(-4)}`;
  if (value.length > 4) return `…${value.slice(-2)}`;
  return '…';
}

/** Full environment scan: agent CLIs on PATH, scribe history dirs, API keys. */
export function scanEnvironment(opts: ScanOptions = {}): EnvironmentScan {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const pathEnv = opts.pathEnv ?? env.PATH ?? '';
  const platform = opts.platform ?? process.platform;

  return {
    clis: AGENT_CLIS.map((name) => {
      const found = findOnPath(name, { pathEnv, platform });
      return { name, found: found !== null, path: found };
    }),
    historyDirs: AGENT_CLIS.map((name) => {
      const dir = join(homeDir, HISTORY_DIRS[name]);
      return { name, dir, present: existsSync(dir) };
    }),
    apiKeys: KNOWN_API_KEY_ENVS.filter((name) => {
      const value = env[name];
      return typeof value === 'string' && value.trim() !== '';
    }).map((name) => ({ env: name, masked: maskSecret(env[name]!) })),
  };
}
