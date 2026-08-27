import { getPinnedKernelVersion } from '../lib/version-policy.js';
import { collectStatus, nextStepSuggestion, type SystemStatus } from '../lib/system-status.js';
import { resolvePaths } from '../lib/paths.js';
import { bold, cmd, emph, err, green, muted, printBoxed, red, warn, yellow } from '../lib/ansi.js';
import type { ScribeStatus } from '../scribe/status.js';
import { SCRIBE_SOURCES, type ScribeSource } from '../scribe/types.js';

export function formatScribeSource(source: ScribeSource, status: ScribeStatus | null): string {
  const s = status?.sources[source];
  if (s === undefined) return `  ${bold(source)}: ${muted('(no status yet)')}`;
  if (!s.rootPresent) return `  ${bold(source)}: ${warn(`root absent (${s.root})`)}`;
  const last = s.lastEventAt ?? '—';
  const parseErrors = s.parseErrors > 0 ? red(String(s.parseErrors)) : String(s.parseErrors);
  return `  ${bold(source)}: ${s.filesProcessed}/${s.filesSeen} files, ${s.events} events, ${parseErrors} parse errors, last event ${last}`;
}

/**
 * `previously status` — report kernel liveness, port reachability, kernel
 * version/compatibility, bridge CLI presence, scribe health, and a config
 * summary. Exit code reflects the worst subsystem honestly (§9): 0 only when
 * the kernel is running AND reachable AND version-compatible AND the scribe
 * is alive alongside it with no recorded errors.
 *
 * All aggregation lives in lib/system-status.ts (collectStatus).
 *
 * Styling comes from lib/ansi.ts and switches itself off for non-TTY
 * consumers, so piped output stays byte-stable plain text.
 */
export async function run(args: string[]): Promise<number> {
  void args;
  const s: SystemStatus = await collectStatus(resolvePaths());
  const { paths, config } = s;

  const lines: string[] = [];
  lines.push(`${bold('Home:')}      ${emph(paths.home)}`);
  lines.push(
    `${bold('Config:')}    ${s.initialized ? emph(paths.configPath) : muted('(not created — run ') + cmd('previously init') + muted(')')}`,
  );
  lines.push(`${bold('Kernel:')}    ${s.kernelAlive ? green(`running (pid ${s.kernelPid})`) : muted('not running')}`);
  if (s.kernelVersion !== null) {
    lines.push(
      `${bold('Version:')}   ${s.kernelVersion} (pinned ${getPinnedKernelVersion()} — ${s.compat!.ok ? green('compatible') : red(bold('INCOMPATIBLE'))}, source: ${s.kernelSource})`,
    );
  } else {
    lines.push(`${bold('Version:')}   ${muted('unknown')} (no installed kernel pointer; dir: ${emph(s.kernelDir)})`);
  }
  // Reachable means SOMETHING answers on the port — when our kernel is not
  // the responder, say so instead of implying health.
  const portState = s.reachable
    ? s.kernelAlive
      ? green('reachable')
      : yellow('reachable — but the kernel is not running; another process is listening')
    : red('unreachable');
  lines.push(`${bold('Port:')}      ${emph(`${config.hostname}:${config.port}`)} ${portState}`);
  lines.push(`${bold('Storage:')}   ${config.storage} (memory root: ${emph(config.memoryRoot)})`);
  if (s.memoryRepo !== null) {
    if (s.memoryRepo.busy === true) {
      lines.push(
        `${bold('Memory repo:')} ${warn('git state temporarily unavailable')} ${muted('— another process may be mid-commit; re-run')} ${cmd('previously status')}`,
      );
    } else {
      const changes =
        s.memoryRepo.uncommitted === 0
          ? 'clean'
          : `${s.memoryRepo.uncommittedCapped ? '99+' : s.memoryRepo.uncommitted} uncommitted change(s)`;
      const lastCommit = s.memoryRepo.lastCommitAt ?? 'no commits yet';
      lines.push(`${bold('Memory repo:')} ${s.memoryRepo.branch ?? '(no branch)'} — ${changes}, last commit ${lastCommit}`);
    }
  } else {
    lines.push(
      `${bold('Memory repo:')} ${warn('not a git repository')} ${muted('— re-run')} ${cmd('previously init')} ${muted('to create/adopt it')}`,
    );
  }
  lines.push(`${bold('Backend:')}   ${config.executionBackend ?? muted('(unset)')}`);
  for (const bridge of s.bridges) {
    lines.push(
      `  bridge ${bold(bridge.agent)}: ${bridge.found ? green(`found (${bridge.detail})`) : yellow(`not found — ${bridge.detail}`)}`,
    );
  }

  lines.push(`${bold('Scribe:')}    ${s.scribeAlive ? green(`running (pid ${s.scribePid})`) : muted('not running')}`);
  for (const source of SCRIBE_SOURCES) {
    lines.push(formatScribeSource(source, s.scribeStatus));
  }
  if (s.scribePid !== null && !s.scribeAlive) {
    lines.push(`${bold('Note:')}      ${muted(`stale scribe pid file at ${paths.scribePidPath} (pid ${s.scribePid} is not running)`)}`);
  }
  if (s.scribeStatus !== null && s.scribeStatus.errors.length > 0) {
    const last = s.scribeStatus.errors[s.scribeStatus.errors.length - 1]!;
    lines.push(`${bold('Scribe errors:')} ${yellow(`${s.scribeStatus.errors.length} recent (latest: ${last.file}: ${last.message})`)}`);
  }

  if (s.kernelPid !== null && !s.kernelAlive) {
    lines.push(`${bold('Note:')}      ${muted(`stale pid file at ${paths.pidPath} (pid ${s.kernelPid} is not running)`)}`);
  }

  const suggestion = nextStepSuggestion(s);
  if (suggestion !== null) lines.push(`${yellow(bold('Next:'))}      ${suggestion}`);

  printBoxed(lines, { pad: true });

  if (s.compat && !s.compat.ok) {
    console.error(err(s.compat.message!));
    return 1;
  }

  if (!(s.kernelAlive && s.reachable)) return 1;

  // Kernel healthy; the scribe is part of a healthy `start`ed system (§2/§3):
  // a dead scribe beside a live kernel, or recorded scribe errors, is a
  // degraded system and must not report success.
  if (!s.scribeAlive) {
    console.error(err('Scribe is not running while the kernel is — degraded. Restart with `previously stop && previously start`.'));
    return 1;
  }
  if (s.scribeStatus !== null && s.scribeStatus.errors.length > 0) {
    console.error(err(`Scribe has ${s.scribeStatus.errors.length} recorded error(s) — degraded. See \`previously logs\` and the status file.`));
    return 1;
  }
  return 0;
}
