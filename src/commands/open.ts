import { loadConfig } from '../lib/config.js';
import { isPortOpen } from '../lib/health.js';
import { openBrowser, type OpenResult } from '../lib/open-browser.js';
import { resolvePaths } from '../lib/paths.js';
import { cmd, emph, err, muted, ok } from '../lib/ansi.js';
import { checkPidFile } from '../lib/process.js';

export interface OpenCommandDeps {
  /** Test hook: replace the real browser spawn. */
  openBrowserFn?: (url: string) => OpenResult;
}

/**
 * `previously open` — open the Web UI in the browser. Fails honestly when
 * nothing is listening: the fix is `previously start`, not retrying open.
 */
export async function run(args: string[], deps: OpenCommandDeps = {}): Promise<number> {
  void args;
  const paths = resolvePaths();
  const config = loadConfig(paths);
  const url = `http://${config.hostname}:${config.port}`;

  const alive = checkPidFile(paths.pidPath).status === 'running';
  const reachable = await isPortOpen(config.port, config.hostname, 1_500);
  if (!alive && !reachable) {
    console.error(err(`Previously is not running — nothing to open at ${url}.`));
    console.error(`Run ${cmd('`previously start`')} to start it.`);
    return 1;
  }

  const result = (deps.openBrowserFn ?? openBrowser)(url);
  if (!result.ok) {
    console.error(err(`Could not open the browser: ${result.error ?? 'unknown error'}`));
    console.error(muted(`Open ${url} manually.`));
    return 1;
  }
  console.log(result.skipped === true ? muted(`PREVIOUSLY_NO_OPEN=1 — open ${url} manually.`) : ok(`Opened ${emph(url)}`));
  return 0;
}
