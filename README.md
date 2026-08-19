# Previously Client

Previously 的本地客户端：同一内核的本地实例 + 本地感知末梢，npm CLI 形态分发。

- 本地运行 Previously 内核（云端 [agent 仓库](https://github.com/previously-lab/agent) 的 standalone 产物）
- 抄录本机其他 AI Agent（Claude Code / Codex / Kimi Code 等）的对话为时间片
- 通过 MCP 向本机 Agent 暴露只读记忆
- 可复用本地已有的 Agent 订阅作为执行后端；~~通过 Connect 接受云端 Previously 的指挥~~（Connect 暂缓封存，见设计文档）

设计文档见 [docs/design/v0.1-client.md](docs/design/v0.1-client.md)。

## Development

Requirements: Node.js ≥ 20, pnpm.

```bash
pnpm install   # install dependencies
pnpm build     # compile TypeScript to dist/
pnpm test      # run the vitest suite
```

Run the CLI from source (after `pnpm build`):

```bash
node dist/cli.js <command>
```

Point `PREVIOUSLY_HOME` at a scratch directory to avoid touching your real `~/.previously`:

```bash
PREVIOUSLY_HOME=/tmp/prev-test node dist/cli.js init
```

Current commands (batch C1): `init`, `start`, `stop`, `status`, `logs`. `start` requires the kernel standalone build (`server.js`, produced by the [agent repo](https://github.com/previously-lab/agent)) in `~/.previously/kernel/` — without it, `start` fails with an actionable error.
