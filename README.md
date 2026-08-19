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

Current commands (batches C1 + C1.5 + C2 + C3 + C4): `init`, `start`, `stop`, `status`, `logs`, `kernel`, `upgrade`, `mcp`, `install`, `uninstall`, `watch`, `scribe`, `bridge-exec`.

内核供应链（设计文档 §10）：`previously kernel install --repo <git-url> --ref <branch|tag|sha>` 从 agent 仓库浅克隆并构建 standalone 产物，安装到 `~/.previously/kernel/versions/<version>/`，原子切换 `kernel/current.json` 指针，可 `previously kernel rollback` 回滚。版本策略：client 内嵌内核 minor 版本线（package.json `previously.kernelLine`，当前 `0.8`），内核 major.minor 必须与版本线一致，patch 自由；`previously upgrade` 装版本线内最新 patch，跨 minor 拒绝并提示先升级 client。测试/逃逸通道：`previously kernel install --from <dir> --version <x.y.z>` 直接把本地 standalone 目录当作已构建产物安装。`start`/`status` 经指针解析内核目录并做兼容校验；config `kernelDir` 为显式覆盖。

Repo builds require `git` and `pnpm` on PATH (shell-outs via `node:child_process`). Without any installed kernel, `start` falls back to a hand-placed standalone build in `~/.previously/kernel/` and fails with an actionable error if none exists.

能力出口（设计文档 §6）：`previously mcp serve` 以 stdio MCP server（换行分隔的 JSON-RPC 2.0，零依赖手写实现）暴露只读记忆工具 `read_timeline` / `read_slice` / `list_strands` / `read_strand` / `search_memory`，直接读 memory 目录；slice id 严格校验防路径穿越，缺失/非法输入一律如实报结构化错误。`previously install --claude|--codex|--kimi|--all`（可选 `--project <dir>`、`--dry-run`）把 server 注册进各家配置（Claude: `.mcp.json`/`~/.claude.json` 的 `mcpServers`；Codex: `~/.codex/config.toml` 的 `[mcp_servers.previously]`；Kimi: `.kimi-code/mcp.json`/`~/.kimi-code/mcp.json`），spawn 命令为 node + dist/cli.js 绝对路径（Windows 可用），首次修改前备份一次 `<file>.bak`，只动自己的条目、幂等；`previously uninstall` 对称移除。

感知末梢（设计文档 §5，批次 C3）：Scribe 抄录器用 chokidar 监听 `~/.claude/projects/**/*.jsonl`（Claude Code）与 `~/.codex/sessions/**/*.jsonl`（Codex），按字节偏移量 + 链式内容 hash 的增量游标（`~/.previously/scribe/cursors.json`，原子写入）把会话日志转录为与内核同构的时间片：`memory/episodic/slices/YYYY/MM/DD/HHMM/timeline/core.md` + 月度 `_index.json`（条目带 `source` / `sessionId` 来源标签）。解析按家隔离成插件（`src/scribe/parsers/`）；格式漂移的行不中断管线，降级为 `timeline/appendix.md` 原文附录并计入 parse errors（§5.3 格式税）。截断/轮换检测（文件变短即从 0 重读），重启从游标恢复，重复转录字节级幂等。`previously watch` 前台运行（`start` 会以独立 detached 进程自动拉起，自带 pid 文件与日志；`stop` 两者皆停；`status` 报告每个来源的文件数/事件数/最后事件时间/解析错误数）；`previously scribe once [--source claude-code|codex]` 一次性全量扫描，用于回填与调试。

订阅桥接（设计文档 §7，批次 C4）：`previously bridge-exec` 是内核 delegateTask 工具（agent 仓库 client mode，`PREVIOUSLY_BRIDGE_CMD`，默认 `previously bridge-exec`）的本地执行端，契约严格对齐：stdin 收 `{"task","context"}` JSON → 路由到适配器（`--agent claude|codex|kimi`，缺省取 config `executionBackend`，`previously init --backend ...` 设置）→ stdout 输出最终纯文本结果，exit 0 成功；失败一律非零退出 + stderr 诊断（§9 失败哲学：CLI 缺失 / 鉴权或配额报错原文 / 超时 / 流格式漂移，绝不伪造输出；exit 0 必伴随非空 stdout，否则内核视为 malformed）。三家适配器接口对齐（`dispatch({task, context}) → result text`）：Claude 走 `claude -p --output-format stream-json --verbose --max-turns N`（prompt 经 stdin 传入，避开 Windows argv 长度限制；N 默认 25，`PREVIOUSLY_BRIDGE_CLAUDE_MAX_TURNS=none` 关闭），Kimi 走 `kimi -p <prompt> --output-format stream-json`，Codex 走 `codex exec --json <prompt>`（v1 不做任何指令注入，AGENTS.md 是用户自己仓库的设置）。鉴权全部使用用户既有订阅 OAuth，client 不碰 API key。超时默认 9.5 分钟（略低于内核 delegateTask 默认 10 分钟，保证适配器先给出如实超时错误），`PREVIOUSLY_BRIDGE_<AGENT>_TIMEOUT_MS` / 全局 `PREVIOUSLY_BRIDGE_TIMEOUT_MS` 可调；bridge-exec 收到 SIGTERM/SIGINT 会转发杀死子进程。每家 CLI 可用 `PREVIOUSLY_BRIDGE_<AGENT>_CMD` 覆盖（可带额外前导参数，如 `PREVIOUSLY_BRIDGE_KIMI_CMD="kimi --auto"`）；`previously status` 展示 backend 与三家 CLI 的 PATH 探测结果（如实报 not found）。flag 与流格式假设：claude 2.1.204 与 kimi 0.34.0 已在本机真实验证（最小 prompt 各一次）；codex 本机无二进制，形状属假设、由 fixture CLI 测试覆盖。全部测试使用模拟各家 stream-json 输出的 fixture CLI（`tests/bridge-fixtures.ts`），e2e 通过真实构建的 `dist/cli.js bridge-exec` 逐字节验证内核契约。
