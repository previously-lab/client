# Previously Client

The local client for [Previously](https://previously.ldwid.com) — an AI agent
that remembers by *when*, not by chat thread. One npm package turns your
machine into a full Previously instance: the same kernel, running locally,
with your memory in a plain folder you own.

## What it does

- **Runs the Previously kernel locally** — the prebuilt
  [`previously-kernel`](https://www.npmjs.com/package/previously-kernel)
  package, exact-version pinned. No build tools, no git required.
- **Your memory is a local git repository** — plain Markdown time slices under
  `~/Documents/Previously`, committed on the same cadence as the cloud
  version. Push it to a private repo if you like; it's just files.
- **Two engines, your choice** — bring your own API key (BYOK), or bridge the
  agent subscriptions you already have (Claude Code / Codex / Kimi Code) and
  pay nothing extra.
- **Transcribes your other agents' history** — a scribe turns your existing
  Claude Code / Codex / Kimi Code / Gemini CLI sessions into time slices, and
  a memory skill lets those agents read your Previously memory back.

## Quick start

```bash
npm i -g previously-client
previously     # first run: guided setup. Later: status dashboard.
```

`previously start` launches the kernel, `previously open` opens the Web UI.
That is all you need to remember.

## Documentation

User-facing docs (concepts, configuration, self-hosting the cloud kernel)
live at **[previously.ldwid.com/docs](https://previously.ldwid.com/docs)**.

Inside this repo:

- `docs/design/` — design documents (start with `v0.1-client.md`)
- `docs/reference.md` — the full command surface, config contract, kernel
  supply chain, ingest/scribe/bridge internals, and support matrix
- `docs/release-process.md` — how releases are cut

## Development

Requires Node.js ≥ 20 and pnpm.

```bash
pnpm install
pnpm build     # compile TypeScript to dist/
pnpm test      # vitest suite
pnpm dev       # one-command local loop (expects the agent repo as a sibling)
```

## License

MIT © Previously Lab
