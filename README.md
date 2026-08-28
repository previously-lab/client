# Previously Client

The local client for [Previously](https://previously.ldwid.com) — an AI agent
that remembers by *when*, not by chat thread. One npm package turns your
machine into a full Previously instance: the same kernel, running locally,
with your memory in a plain folder you own.

> **Status: early preview.** The client is functional and tested, but the
> command surface and config format may still shift between preview releases.

## What it does

- **Runs the Previously kernel locally** — the prebuilt
  [`@previously-lab/kernel`](https://www.npmjs.com/package/@previously-lab/kernel)
  package, exact-version pinned. No build tools, no git required.
- **Your memory is a local git repository** — plain Markdown time slices under
  `~/Documents/Previously` (configurable), committed on the same cadence as
  the cloud version. Push it to a private GitHub repo if you like; a cloud
  deployment of Previously can read the same repo remotely. It's just files.
- **Two engines, your choice** — bring your own API key (BYOK) for the full
  streaming experience identical to the cloud, or bridge the agent
  subscriptions you already have (Claude Code / Codex / Kimi Code) and pay
  nothing extra. The bridge is a compatibility path: some agent behavior is
  limited by the target CLI, so BYOK is what we recommend.
- **Transcribes your other agents' history** — a scribe turns your existing
  Claude Code / Codex / Kimi Code / Gemini CLI sessions into time slices, and
  a memory skill lets those agents read your Previously memory back.

## Requirements

- Node.js ≥ 22.13
- An API key (BYOK) *or* one of Claude Code / Codex / Kimi Code installed for
  the subscription bridge
- No Docker, no global git installation — the memory repo is driven over
  isomorphic-git

## Quick start

```bash
npm i -g @previously-lab/client@preview
previously     # first run: guided setup. Later: status dashboard.
```

`previously start` launches the kernel, `previously open` opens the Web UI.
That is all you need to remember.

## Everyday commands

| Command | What it does |
|---------|--------------|
| `previously` | The front door — init wizard on first run, status dashboard after |
| `previously start` | Start the kernel (and scribe) in the background |
| `previously stop` | Stop the background kernel and scribe |
| `previously status` | Kernel status, version compatibility, config summary |
| `previously open` | Open the Web UI in your browser |
| `previously logs` | Tail kernel and scribe logs |

The advanced surface — `init` flags for scripts/agents, `kernel` version
management, `ingest`, `scribe once`, `install`/`uninstall` of the agent skill
group, and the constrained reader commands bridged agents use (`readslice`,
`timeline`, `strands`, `card`, …) — is documented in
[`docs/reference.md`](docs/reference.md) and via `previously --help`.

## How it fits together

**Kernel supply chain.** The client itself is a thin launcher. The real
product ships as `@previously-lab/kernel`, pinned to an exact version — no
ranges, not even on the patch digit. Each kernel installs into
`~/.previously/kernel/versions/<version>/`, and switching is a single atomic
flip of a `current.json` pointer: the old version stays in place until the
new one is up. Upgrading the client upgrades everything; installing an older
client rolls everything back.

**Memory as a git repo.** Slices, strands, the user card, and the evolution
archive live in one plain folder (default `~/Documents/Previously`) that the
kernel commits to as you talk. You can relocate or re-link it during init
(`--memory-root`), and push it to any private remote for backup or cloud
sharing.

**Configuration.** All state lives under `~/.previously` (override with
`PREVIOUSLY_HOME`): `config.json` holds the engine choice, model settings,
and memory root. Every `previously` run audits the config and repairs it if
broken (a `.bak` is kept). Set `PREVIOUSLY_NO_OPEN=1` to never auto-open a
browser.

## Updating

```bash
npm i -g @previously-lab/client@preview
```

(Once 0.9 stable ships, plain `@previously-lab/client` tracks `latest`.)
The kernel travels as the client's pinned dependency, so there is no separate
kernel upgrade command — and no "client and kernel versions disagree" state.

## Documentation

User-facing docs (concepts, configuration, self-hosting the cloud kernel)
live at **[previously.ldwid.com/docs](https://previously.ldwid.com/docs)**.

Inside this repo:

- `docs/design/` — design documents (start with `v0.1-client.md`)
- `docs/reference.md` — the full command surface, config contract, kernel
  supply chain, ingest/scribe/bridge internals, and support matrix
- `docs/release-process.md` — how releases are cut

## Development

Requires Node.js ≥ 22.13 and pnpm.

```bash
pnpm install
pnpm build     # compile TypeScript to dist/
pnpm test      # vitest suite
pnpm dev       # one-command local loop (expects the agent repo as a sibling)
```

## License

MIT © Previously Lab
