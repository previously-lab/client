import { existsSync } from 'node:fs';
import { countScribeSlices } from '../lib/ingest.js';
import { resolvePaths } from '../lib/paths.js';
import { collectStatus, nextStepSuggestion, type SystemStatus } from '../lib/system-status.js';
import { getPinnedKernelVersion } from '../lib/version-policy.js';
import {
  banner,
  bold,
  cmd,
  cmdTable,
  emph,
  gray,
  green,
  muted,
  printBoxed,
  red,
  stylingOn,
  yellow,
} from '../lib/ansi.js';
import { SCRIBE_SOURCES } from '../scribe/types.js';
import { run as initRun, type InitOptions } from './init.js';
import { formatScribeSource, run as statusRun } from './status.js';

/**
 * Bare `previously` — the front door:
 *
 *  1. never initialized → run the initialization flow (the wizard on a TTY,
 *     non-interactive defaults otherwise, so an agent can just say
 *     "initialize previously" and it works)
 *  2. initialized        → print the status dashboard (TTY) or exactly
 *     `previously status` output (non-TTY, script-safe)
 *
 * The bare command never starts services and never opens a browser —
 * that is `previously start` / `previously open`.
 */

export interface LaunchDeps {
  /** Defaults to stdin+stdout TTY detection. */
  isTTY?: boolean;
  /** Dependency seams so tests never touch the real machine. */
  initFn?: (args: string[], opts?: InitOptions) => Promise<number>;
  statusFn?: (args: string[]) => Promise<number>;
  statusCollector?: typeof collectStatus;
}

function printDashboard(s: SystemStatus): void {
  const { paths, config } = s;
  const url = `http://${config.hostname}:${config.port}`;

  const lines: string[] = [];
  lines.push(
    `${bold('Service:')}   ${s.kernelAlive ? green(`running (pid ${s.kernelPid})`) : 'not running — start with ' + cmd('`previously start`')} · Web UI ${emph(url)} (${s.reachable ? green('reachable') : red('unreachable')})`,
  );
  if (s.kernelAlive) lines.push(`           stop with ${cmd('`previously stop`')}`);
  if (s.kernelVersion !== null) {
    lines.push(
      `${bold('Version:')}   ${s.kernelVersion} (pinned ${getPinnedKernelVersion()} — ${s.compat!.ok ? green('compatible') : red(bold('INCOMPATIBLE'))})`,
    );
  }
  lines.push(`${bold('Scribe:')}    ${s.scribeAlive ? green(`running (pid ${s.scribePid})`) : muted('not running')}`);
  for (const source of SCRIBE_SOURCES) {
    lines.push(formatScribeSource(source, s.scribeStatus));
  }
  lines.push(`${bold('Storage:')}   ${emph(config.memoryRoot)} — ${countScribeSlices(config.memoryRoot)} transcribed slice(s)`);
  lines.push(`${bold('Backend:')}   ${config.executionBackend ?? muted('(unset)')}`);
  for (const bridge of s.bridges) {
    lines.push(`  bridge ${bold(bridge.agent)}: ${bridge.found ? green('found') : yellow('not found')}`);
  }

  const suggestion = nextStepSuggestion(s);
  if (suggestion !== null) {
    lines.push('');
    lines.push(`${yellow(bold('Next:'))}      ${suggestion}`);
  }

  lines.push('');
  lines.push(gray('Commands:  previously start · stop · status · logs · open · init — `previously --help` for everything'));

  printBoxed(lines, { title: 'Previously — status' });
}

/**
 * Styled dashboard (TTY with color): brand banner + per-subsystem cards +
 * a `$`-prompt command table — the Vue CLI / Next.js CLI shape. Plain
 * terminals and scripts keep printDashboard's byte-stable output.
 */
function printDashboardFancy(s: SystemStatus): void {
  const { config } = s;
  const url = `http://${config.hostname}:${config.port}`;

  for (const line of banner('Previously', 'local long-term memory for your agents')) console.log(line);
  console.log('');

  // ── Service ────────────────────────────────────────────────
  const service: string[] = [];
  if (s.kernelAlive) {
    service.push(`${green('✓')} ${bold('Kernel')}   running (pid ${s.kernelPid})`);
    service.push(`          ${muted(`stop with ${cmd('`previously stop`')}`)}`);
  } else {
    service.push(`${red('✗')} ${bold('Kernel')}   not running — start with ${cmd('`previously start`')}`);
  }
  service.push(
    `${s.reachable ? green('✓') : red('✗')} ${bold('Web UI')}   ${emph(url)} (${s.reachable ? green('reachable') : red('unreachable')})`,
  );
  if (s.kernelVersion !== null) {
    service.push(
      `  ${bold('Version')}  ${s.kernelVersion} (pinned ${getPinnedKernelVersion()} — ${s.compat!.ok ? green('compatible') : red(bold('INCOMPATIBLE'))})`,
    );
  }
  printBoxed(service, { title: 'Service', pad: true });
  console.log('');

  // ── Scribe ─────────────────────────────────────────────────
  const scribe: string[] = [];
  scribe.push(
    s.scribeAlive ? `${green('✓')} running (pid ${s.scribePid})` : `${red('✗')} ${muted('not running')}`,
  );
  for (const source of SCRIBE_SOURCES) {
    scribe.push(formatScribeSource(source, s.scribeStatus).replace(/^  /, ''));
  }
  printBoxed(scribe, { title: 'Scribe', pad: true });
  console.log('');

  // ── Setup ──────────────────────────────────────────────────
  const bridges = s.bridges
    .map((b) => `${bold(b.agent)} ${b.found ? green('✓') : red('✗')}`)
    .join(muted(' · '));
  printBoxed(
    [
      `${bold('Storage')}  ${emph(config.memoryRoot)} — ${countScribeSlices(config.memoryRoot)} transcribed slice(s)`,
      `${bold('Backend')}  ${config.executionBackend ?? muted('(unset)')}`,
      `${bold('Bridges')}  ${bridges}`,
    ],
    { title: 'Setup', pad: true },
  );

  // ── Next steps ─────────────────────────────────────────────
  const suggestion = nextStepSuggestion(s);
  if (suggestion !== null) {
    console.log('');
    console.log(`  ${yellow('→')} ${suggestion}`);
  }
  console.log('');
  for (const line of cmdTable([
    ['previously start', 'start the kernel + scribe'],
    ['previously stop', 'stop them'],
    ['previously open', 'open the Web UI'],
    ['previously logs', 'tail the logs'],
    ['previously --help', 'everything else'],
  ])) {
    console.log(line);
  }
}

export async function run(args: string[], deps: LaunchDeps = {}): Promise<number> {
  void args;
  const paths = resolvePaths();
  const isTTY = deps.isTTY ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));

  // State 1: never initialized — the bare command IS initialization.
  if (!existsSync(paths.configPath)) {
    return (deps.initFn ?? initRun)([], { isTTY: isTTY });
  }

  // State 2: initialized. Non-TTY stays exactly `previously status` so
  // scripts and CI get stable, parseable output.
  if (!isTTY) return (deps.statusFn ?? statusRun)([]);

  const s = await (deps.statusCollector ?? collectStatus)(paths);
  if (stylingOn()) printDashboardFancy(s);
  else printDashboard(s);
  return 0;
}
