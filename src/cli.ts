#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import * as bridgeExec from './commands/bridge-exec.js';
import * as init from './commands/init.js';
import * as install from './commands/install.js';
import * as kernel from './commands/kernel.js';
import * as launch from './commands/launch.js';
import * as logs from './commands/logs.js';
import * as open from './commands/open.js';
import * as scribe from './commands/scribe.js';
import * as start from './commands/start.js';
import * as status from './commands/status.js';
import * as stop from './commands/stop.js';
import * as upgrade from './commands/upgrade.js';

type CommandHandler = (args: string[]) => Promise<number>;

const commands: Record<string, CommandHandler> = {
  init: init.run,
  start: start.run,
  stop: stop.run,
  status: status.run,
  logs: logs.run,
  open: open.run,
  kernel: kernel.run,
  upgrade: upgrade.run,
  scribe: scribe.runScribe,
  watch: scribe.runWatch,
  install: install.run,
  uninstall: install.runUninstall,
  'bridge-exec': bridgeExec.run,
};

function usage(): void {
  console.log(`previously — local client for the Previously kernel

Usage: previously [command]

Everyday:
  (no command)  Launch Previously: start the service (if needed), open the
                Web UI, and print a short summary
  start         Start the kernel in the background and wait until it responds
  stop          Stop the background kernel and scribe
  status        Show kernel status, version/compat, and config summary (+ next-step hint)
  logs          Tail the kernel and scribe logs (-n/--lines, -s/--source kernel|scribe)
  open          Open the Web UI in your browser

Advanced:
  init        Create the ~/.previously layout and config (--force; --backend claude|codex|kimi|api-key|none)
  kernel      Manage kernel versions (install / list / current / rollback)
  upgrade     Install the newest kernel release within the supported version line
  install     Write the "Previously memory" skill pack for detected agent CLIs (--claude / --codex / --kimi / --all)
  uninstall   Remove the Previously skill pack from agent configs
  watch       Run the scribe in the foreground (fs watch → time slices; start includes it)
  scribe      Scribe one-shot scan: scribe once [--source claude-code|codex|kimi-code|gemini]
  bridge-exec Subscription bridge entry for the kernel delegateTask tool (JSON on stdin, result on stdout)

Environment:
  PREVIOUSLY_HOME     Root for all state (default: ~/.previously)
  PREVIOUSLY_NO_OPEN  Set to 1 to never auto-open the browser
`);
}

function version(): string {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === '--version' || command === '-v') {
    console.log(version());
    return 0;
  }
  if (command === undefined) {
    // The bare command is the product: start (if needed) + open the Web UI.
    // Exit 1 with guidance when uninitialized.
    return launch.run([]);
  }
  if (command === '--help' || command === '-h') {
    usage();
    return 0;
  }

  const handler = commands[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    usage();
    return 1;
  }
  return handler(rest);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
