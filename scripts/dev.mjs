#!/usr/bin/env node
/**
 * `pnpm dev` — one-command local development loop.
 *
 * Discovers the agent (kernel) repo among this repo's SIBLING directories,
 * builds its standalone artifact, builds this CLI, makes sure ~/.previously
 * is initialized (auto-detecting installed agent CLIs), installs the fresh
 * kernel, and finally starts the service and opens the Web UI
 * (`previously start` + `previously open`).
 *
 * Discovery: every sibling directory whose name matches one of
 *   aftrbrez · agent · previously-agent · previously-kernel · kernel
 * (case-insensitive) is validated as the agent repo (package.json with a
 * `next` dependency + src/lib/version/constants.ts). Exactly one match is
 * required — zero or several matches produce an honest error that points at
 * the PREVIOUSLY_AGENT_REPO escape hatch.
 *
 * Flags:
 *   --fast      skip the agent repo build (reuse its existing .next/standalone)
 *   --no-start  stop after installing the kernel (CI / scripted checks)
 *
 * Env:
 *   PREVIOUSLY_AGENT_REPO  absolute path to the agent repo — skips discovery.
 *     Read from the shell environment, or from a gitignored `dev.env` file in
 *     this repo's root (KEY=VALUE lines, `#` comments). The shell environment
 *     wins when both are set. No global/user-level env var is ever needed.
 *   PREVIOUSLY_HOME        state root (default ~/.previously, as usual)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLIENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATE_NAMES = ['aftrbrez', 'agent', 'previously-agent', 'previously-kernel', 'kernel'];

// Load dev.env (repo root, gitignored) — the cross-platform way to pin local
// dev settings. Real environment variables take precedence over the file.
function loadDevEnv() {
  const file = join(CLIENT_ROOT, 'dev.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDevEnv();

const args = new Set(process.argv.slice(2));
const fast = args.has('--fast');
const noStart = args.has('--no-start');

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function step(title) {
  console.log(`\n── ${title}`);
}

function run(cmd, cmdArgs, cwd) {
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: true });
  if (r.error) fail(`could not run "${cmd} ${cmdArgs.join(' ')}": ${r.error.message}`);
  if (r.status !== 0) fail(`"${cmd} ${cmdArgs.join(' ')}" failed (exit ${r.status}) — see the output above.`);
}

// ─── 1. Find the agent repo ────────────────────────────────────────────────

function looksLikeAgentRepo(dir) {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next === undefined) return false;
  } catch {
    return false;
  }
  return existsSync(join(dir, 'src', 'lib', 'version', 'constants.ts'));
}

function resolveAgentRepo() {
  const fromEnv = process.env.PREVIOUSLY_AGENT_REPO?.trim();
  if (fromEnv) {
    const dir = resolve(fromEnv);
    if (!looksLikeAgentRepo(dir)) {
      fail(`PREVIOUSLY_AGENT_REPO=${dir} does not look like the agent repo ` +
        `(needs package.json with a "next" dependency and src/lib/version/constants.ts).`);
    }
    return dir;
  }

  const parent = dirname(CLIENT_ROOT);
  const matches = readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && CANDIDATE_NAMES.includes(e.name.toLowerCase()))
    .map((e) => join(parent, e.name))
    .filter(looksLikeAgentRepo);

  if (matches.length === 0) {
    fail(`no agent repo found next to this one (looked in ${parent} for: ${CANDIDATE_NAMES.join(', ')}).\n` +
      `Clone the agent repo as a sibling directory, or add PREVIOUSLY_AGENT_REPO=<path> to dev.env in this repo's root.`);
  }
  if (matches.length > 1) {
    fail(`several sibling directories look like the agent repo:\n  ${matches.join('\n  ')}\n` +
      `Pick one explicitly: add PREVIOUSLY_AGENT_REPO=<path> to dev.env in this repo's root.`);
  }
  return matches[0];
}

// ─── The pipeline ──────────────────────────────────────────────────────────

const agentRepo = resolveAgentRepo();
console.log(`Agent repo: ${agentRepo}`);
const standaloneDir = join(agentRepo, '.next', 'standalone');

if (!fast) {
  step('Building the kernel (agent repo standalone)');
  run('pnpm', ['build:standalone'], agentRepo);
} else {
  step('Skipping the kernel build (--fast)');
}
if (!existsSync(join(standaloneDir, 'server.js'))) {
  fail(`no standalone artifact at ${standaloneDir} (missing server.js). ` +
    `Run without --fast to build it, or run "pnpm build:standalone" in the agent repo.`);
}

step('Building the client CLI');
run('pnpm', ['build'], CLIENT_ROOT);

// The steps below reuse the CLI's own (tested) logic straight from dist/.
const dist = (name) => pathToFileURL(join(CLIENT_ROOT, 'dist', 'lib', name)).href;
const { resolvePaths } = await import(dist('paths.js'));
const { scanEnvironment } = await import(dist('detect.js'));
const { installFromDir } = await import(dist('kernel.js'));
const { getKernelLine } = await import(dist('version-policy.js'));

const paths = resolvePaths();

// Initialization is the CLI's own `init` command — single source of truth:
// first run writes the config (bridge backend → brain included), every run
// audits and repairs the config. --skip-ingest keeps the dev loop fast (run
// bare `previously` once for the guided history import).
step('Initializing ~/.previously (via `previously init`)');
const { run: initRun } = await import(pathToFileURL(join(CLIENT_ROOT, 'dist', 'commands', 'init.js')).href);
const scan = scanEnvironment();
const agent = ['claude', 'codex', 'kimi'].find((n) => scan.clis.find((c) => c.name === n)?.found) ?? null;
const initArgs = ['--non-interactive', '--skip-ingest'];
if (!existsSync(paths.configPath)) initArgs.push('--backend', agent ?? 'none');
if ((await initRun(initArgs, { isTTY: false })) !== 0) {
  fail('initialization failed — see the output above.');
}
console.log(`  brain:    ${agent !== null ? `bridge:${agent} (subscription — no API key needed)` : 'environment keys (no agent CLI found)'}`);
if (agent === null) {
  console.log('  no claude/codex/kimi CLI found on PATH — install one, or set an API key env and re-run.');
}

step('Installing the kernel into ~/.previously');
// Dev versions are timestamped patches on the supported line — always fresh,
// never colliding with a real release.
const version = `${getKernelLine()}.${Math.floor(Date.now() / 1000)}`;
const install = installFromDir({ fromDir: standaloneDir, version, paths });
console.log(`  kernel ${install.pointer.version} → ${install.pointer.dir}`);

// Prune older timestamped dev versions so the versions dir does not grow
// forever. Best-effort: a version whose kernel is currently RUNNING is
// file-locked on Windows (EPERM) — skip it with a note instead of failing
// the whole run; it gets pruned on a later run once stopped.
for (const entry of readdirSync(paths.kernelVersionsDir, { withFileTypes: true })) {
  if (entry.isDirectory() && /^\d+\.\d+\.\d{6,}$/.test(entry.name) && entry.name !== install.pointer.version) {
    try {
      rmSync(join(paths.kernelVersionsDir, entry.name), { recursive: true, force: true });
    } catch (err) {
      console.log(`  (kept ${entry.name}: ${err.code ?? err.message} — likely a running kernel; it will be pruned after \`previously stop\`)`);
    }
  }
}

if (noStart) {
  step('Done (--no-start)');
  console.log('  Run `previously start` (or node dist/cli.js start) to start.');
  process.exit(0);
}

step('Launching Previously');
// Start the kernel + scribe, then open the Web UI. (The bare `previously`
// command no longer starts anything — it shows the status dashboard.)
const started = spawnSync(process.execPath, [join(CLIENT_ROOT, 'dist', 'cli.js'), 'start'], {
  cwd: CLIENT_ROOT,
  stdio: 'inherit',
});
if (started.status !== 0) process.exit(started.status ?? 1);
const opened = spawnSync(process.execPath, [join(CLIENT_ROOT, 'dist', 'cli.js'), 'open'], {
  cwd: CLIENT_ROOT,
  stdio: 'inherit',
});
process.exit(opened.status ?? 1);
