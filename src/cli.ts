#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import * as init from './commands/init.js';
import * as kernel from './commands/kernel.js';
import * as logs from './commands/logs.js';
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
  kernel: kernel.run,
  upgrade: upgrade.run,
};

function usage(): void {
  console.log(`previously — local client for the Previously kernel

Usage: previously <command>

Commands:
  init      Create the ~/.previously layout and default config (idempotent, --force to overwrite)
  start     Start the kernel in the background and wait until it responds
  stop      Stop the background kernel
  status    Show kernel status, version/compat, and config summary
  logs      Tail the kernel log (-n/--lines, default 100)
  kernel    Manage kernel versions (install / list / current / rollback)
  upgrade   Install the newest kernel release within the supported version line

Environment:
  PREVIOUSLY_HOME  Root for all state (default: ~/.previously)
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
  if (command === undefined || command === '--help' || command === '-h') {
    usage();
    return command === undefined ? 1 : 0;
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
