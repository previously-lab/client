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

Current commands (batches C1 + C1.5 + C2 + C3): `init`, `start`, `stop`, `status`, `logs`, `kernel`, `upgrade`, `mcp`, `install`, `uninstall`, `watch`, `scribe`.

内核供应链（设计文档 §10）：`previously kernel install --repo <git-url> --ref <branch|tag|sha>` 从 agent 仓库浅克隆并构建 standalone 产物，安装到 `~/.previously/kernel/versions/<version>/`，原子切换 `kernel/current.json` 指针，可 `previously kernel rollback` 回滚。版本策略：client 内嵌内核 minor 版本线（package.json `previously.kernelLine`，当前 `0.8`），内核 major.minor 必须与版本线一致，patch 自由；`previously upgrade` 装版本线内最新 patch，跨 minor 拒绝并提示先升级 client。测试/逃逸通道：`previously kernel install --from <dir> --version <x.y.z>` 直接把本地 standalone 目录当作已构建产物安装。`start`/`status` 经指针解析内核目录并做兼容校验；config `kernelDir` 为显式覆盖。

Repo builds require `git` and `pnpm` on PATH (shell-outs via `node:child_process`). Without any installed kernel, `start` falls back to a hand-placed standalone build in `~/.previously/kernel/` and fails with an actionable error if none exists.

能力出口（设计文档 §6）：`previously mcp serve` 以 stdio MCP server（换行分隔的 JSON-RPC 2.0，零依赖手写实现）暴露只读记忆工具 `read_timeline` / `read_slice` / `list_strands` / `read_strand` / `search_memory`，直接读 memory 目录；slice id 严格校验防路径穿越，缺失/非法输入一律如实报结构化错误。`previously install --claude|--codex|--kimi|--all`（可选 `--project <dir>`、`--dry-run`）把 server 注册进各家配置（Claude: `.mcp.json`/`~/.claude.json` 的 `mcpServers`；Codex: `~/.codex/config.toml` 的 `[mcp_servers.previously]`；Kimi: `.kimi-code/mcp.json`/`~/.kimi-code/mcp.json`），spawn 命令为 node + dist/cli.js 绝对路径（Windows 可用），首次修改前备份一次 `<file>.bak`，只动自己的条目、幂等；`previously uninstall` 对称移除。

感知末梢（设计文档 §5，批次 C3）：Scribe 抄录器用 chokidar 监听 `~/.claude/projects/**/*.jsonl`（Claude Code）与 `~/.codex/sessions/**/*.jsonl`（Codex），按字节偏移量 + 链式内容 hash 的增量游标（`~/.previously/scribe/cursors.json`，原子写入）把会话日志转录为与内核同构的时间片：`memory/episodic/slices/YYYY/MM/DD/HHMM/timeline/core.md` + 月度 `_index.json`（条目带 `source` / `sessionId` 来源标签）。解析按家隔离成插件（`src/scribe/parsers/`）；格式漂移的行不中断管线，降级为 `timeline/appendix.md` 原文附录并计入 parse errors（§5.3 格式税）。截断/轮换检测（文件变短即从 0 重读），重启从游标恢复，重复转录字节级幂等。`previously watch` 前台运行（`start` 会以独立 detached 进程自动拉起，自带 pid 文件与日志；`stop` 两者皆停；`status` 报告每个来源的文件数/事件数/最后事件时间/解析错误数）；`previously scribe once [--source claude-code|codex]` 一次性全量扫描，用于回填与调试。
