import { spawn } from 'node:child_process';
import { findOnPath } from './detect.js';

/**
 * Open a URL in the user's browser. Fire-and-forget by design: a browser
 * that fails to launch must never fail the command that asked (warn only).
 *
 * Honors PREVIOUSLY_NO_OPEN=1 (CI / headless / user preference) — callers
 * additionally skip on non-TTY before invoking this.
 */

export interface OpenResult {
  ok: boolean;
  /** True when intentionally not opened (PREVIOUSLY_NO_OPEN). */
  skipped?: boolean;
  error?: string;
}

export type SpawnFn = (cmd: string, args: string[]) => void;

const defaultSpawn: SpawnFn = (cmd, args) => {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {
    // Async spawn failure (e.g. xdg-open raced away) — nothing sane to do
    // here; the caller already reported the URL to the user.
  });
  child.unref();
};

function platformCommand(url: string, platform: NodeJS.Platform): { cmd: string; args: string[] } {
  switch (platform) {
    case 'win32':
      // `start` is a cmd builtin; the "" is its window-title argument.
      return { cmd: 'cmd', args: ['/c', 'start', '""', url] };
    case 'darwin':
      return { cmd: 'open', args: [url] };
    default:
      return { cmd: 'xdg-open', args: [url] };
  }
}

export interface OpenBrowserOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
}

export function openBrowser(url: string, opts: OpenBrowserOptions = {}): OpenResult {
  const env = opts.env ?? process.env;
  if (env.PREVIOUSLY_NO_OPEN === '1') return { ok: true, skipped: true };

  const platform = opts.platform ?? process.platform;
  const { cmd, args } = platformCommand(url, platform);
  if (platform !== 'win32' && platform !== 'darwin') {
    // Honest preflight on Linux/BSD: xdg-open is not guaranteed to exist.
    if (findOnPath(cmd, { pathEnv: env.PATH ?? '', platform }) === null) {
      return { ok: false, error: `xdg-open not found on PATH — open ${url} manually` };
    }
  }
  try {
    (opts.spawnFn ?? defaultSpawn)(cmd, args);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
