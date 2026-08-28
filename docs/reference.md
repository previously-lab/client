# Client 实现参考

> 本文档是 README 的详细版备份：命令面、config 契约、内核供应链、skill 投递、ingest、scribe、支持矩阵与桥接契约。概念性介绍见 README；用户向文档见 https://previously.ldwid.com/docs 。设计文档见 docs/design/。

---

# Previously Client

Previously 的本地客户端：同一内核的本地实例 + 本地感知末梢，npm CLI 形态分发。

- 本地运行 Previously 内核（云端 [agent 仓库](https://github.com/previously-lab/agent) 的 standalone 产物）
- 抄录本机其他 AI Agent（Claude Code / Codex / Kimi Code 等）的对话为时间片
- 以「记忆 Skill」向本机 Agent 提供只读记忆访问说明（安装到各家 skills/指令文件，桥接调用时经临时工作目录注入）
- 可复用本地已有的 Agent 订阅作为执行后端；~~通过 Connect 接受云端 Previously 的指挥~~（Connect 暂缓封存，见设计文档）

设计文档见 [docs/design/v0.1-client.md](docs/design/v0.1-client.md)。

## 快速开始

```bash
npm i -g @previously-lab/client   # 或 npx
previously                   # 唯一需要记住的命令
```

注：请用上面的 registry 安装。git-URL 安装（`npm i -g github:...`）会触发 `prepare` 构建钩子，要求本机装有 pnpm 和 typescript，不推荐。

裸 `previously` 是前门：**未初始化时它就是初始化**——TTY 下进入引导式向导（记忆存放位置 → 执行后端（自动探测本机 agent CLI）→ 是否把本机已有 agent 历史转录成时间片 → 已有内容的保留/重建 → 可选的 token 消耗步骤，每一步都先估账、默认不执行）；非 TTY（CI/脚本/agent 调用）自动走非交互模式，用默认值一次跑通并打印每个决策。**已初始化时它显示状态面板**——kernel/scribe 是否在跑、Web UI 地址、如何停止、各源转录进度、常用命令速查与下一步建议；裸命令从不启动服务、从不打开浏览器，启动是 `previously start`，浏览器是 `previously open`。非 TTY 已初始化时输出完全等同 `previously status`，脚本可安全解析。

`previously init` 与裸命令共用同一套初始化流程。agent/脚本用法：`previously init --non-interactive --backend <claude|codex|kimi> [--memory-root <path>] [--json]`；`--rebuild` 丢弃全部转录时间片并从原始日志重建（`--include-custom` 连外部提交内容一起清；内核自己的对话永不动），`--skip-ingest` 只建布局与配置。所有交互式提问都有对应 flag，永不阻塞。选 bridge 后端会顺带把 `brain` 写入 config（订阅模式，无需 API key）。**每次 init 都会审计并修复损坏的 config**（缺 brain、非法端口/后端值、JSON 损坏等，修复前自动备份 `config.json.bak`）；`previously start` 在未初始化时会先自动走 init，且每次启动前也会跑同一套配置审计，保证内核永远拿到合法环境。

命令面分两层——日常：`（无命令）` / `start` / `stop` / `status` / `logs` / `open`；高级：`init` / `kernel` / `install` / `uninstall` / `watch` / `scribe` / `ingest` / `bridge-exec`。

**memory 是一个本地 git 仓库**（v8）：写入语义与云端完全一致——内核每次写盘按云端节奏 commit（一次 chat 回合 = `Turn <id> — housekeeping` + `Turn <id> — agent response` 两个 commit），scribe/ingest 按批次提交，`stop` 兜底清扫未提交变更。默认位置贴平台用户文档目录（`~/Documents/Previously`，无 Documents 则 `~/Previously`），`--memory-root` 或重跑 `init` 可改指/改链——指向一个已有的 Previously 仓库（比如从 GitHub clone 回来的）会直接领养、历史原样保留；指向非空非 git 目录会被拒绝（绝不覆盖用户文件）。git 操作为纯 JS 实现（isomorphic-git），用户机器不需要装 git；commit 失败永不阻断写入。`.workflow-data/`（含 BYOK 序列化载荷）、`logs/`、scribe 游标都在 `PREVIOUSLY_HOME` 而不在仓库内，仓库内容可以放心 push 成私有 GitHub repo。`previously status` 显示仓库分支/未提交数/最后 commit 时间。

config.json 契约（与 agent 仓库严格对齐；`previously init` 只写最小默认值，大脑等运行时配置在内核 Web UI 设置页维护）：`brain?: { "type": "api-key", "env": string, "model"?: string } | { "type": "bridge", "agent": "claude"|"codex"|"kimi" }`（缺省 = 内核沿用环境变量里的 key）；`apiKeys?: Record<string, string>`（手动录入的 key，本地 MVP 明文存储）。`start` 拉起内核时追加注入：`PREVIOUSLY_HOME`、`apiKeys` 每个键值、bridge 大脑时的 `PREVIOUSLY_BRAIN=bridge` + `PREVIOUSLY_BRAIN_AGENT`、api-key 大脑时的 key 值与 `PREVIOUSLY_DEFAULT_MODEL`（内核自 0.9.0 起消费：BYOK 段未写 model 时以它作为默认模型）。

完整命令清单：`（裸命令：初始化/状态面板）`、`init`、`start`、`stop`、`status`、`logs`、`open`、`kernel`、`install`、`uninstall`、`watch`、`scribe`、`ingest`、`bridge-exec`，以及供被桥接 agent 使用的只读命令（`readslice`、`timeline`、`strands`、`card`、`slicesummary`、`agentlog`）。

内核供应链（设计文档 §10）：`previously kernel install` 默认从 client 钉死的 npm 依赖 `@previously-lab/kernel` 安装预构建 standalone 产物——用户机器零构建、不需要 git/pnpm，安装到 `~/.previously/kernel/versions/<version>/`，原子切换 `kernel/current.json` 指针。版本策略：精确绑定——client 钉死一个确切内核版本（package.json `previously.kernelVersion` 与 `dependencies["@previously-lab/kernel"]`，当前 `0.9.0`），内核版本必须完全相等，patch 也不例外；升级 = 升级 client 包本身（不再有 `previously upgrade` / `kernel rollback`）。逃逸与开发者通道：`previously kernel install --from <dir> --version <x.y.z>` 直接把本地 standalone 目录当作已构建产物安装；`previously kernel install --repo [git-url]` 从 agent 仓库浅克隆钉死 tag 并本机构建（开发者用，需要 git + pnpm）。`start`/`status` 经指针解析内核目录并做兼容校验；config `kernelDir` 为显式覆盖。

仅 `--repo` 通道要求 `git` 和 `pnpm` on PATH（shell-outs via `node:child_process`）；默认依赖安装无任何外部工具要求。未安装任何内核时，`start` 回退到手工放置在 `~/.previously/kernel/` 的 standalone 构建，都没有则报错并给出可执行的修复指引。

能力出口：~~只读 MCP server~~（已退役，`previously mcp` 与 MCP 注册均已移除）→ 现为「Previously」skill 组（`src/lib/skills.ts`，`{{MEMORY_ROOT}}` 占位符），一份 skill 目录四份文档：`SKILL.md`（总览与文档地图）、`memory.md`（只读记忆协议：Previously 是什么、memory 目录布局（`episodic/timeline.md`、`timeline/index.json`、`strands.json`、`slices/YYYY/MM/DD/HHMM/timeline/core.md`、月度 `_index.json`）、严格只读规则（持久化由内核/scribe 负责）、何时回忆、最终回复只含答复正文）、`ingest.md`（写入契约，见下）、`setup.md`（首次初始化走查，含逐步 token 成本披露——用户对 agent 说「帮我初始化 Previously」即可被完整执行）。两条投递通道：`previously install [--claude|--codex|--kimi|--all] [--dry-run]` 为每个已检测到的 agent CLI 写用户级格式——Claude: `~/.claude/skills/previously/`（四文件），Kimi: `~/.kimi/skills/previously/`，Codex: 在共享的 `~/.codex/AGENTS.md` 里追加哨兵注释包裹的 Previously 块（四文档拼接，绝不覆盖外来内容）；旧版 `previously-memory` 单文件 skill 目录在安装时自动迁移清理（仅当其中无外来文件）；首次修改前备份一次 `<file>.bak`，幂等，`previously uninstall` 对称移除（只动自己的文件/块）。桥接通道：`bridge-exec` 每次调用前把 memory 协议文档按各家 cwd 约定物化到临时工作目录（claude → `CLAUDE.md`，codex/kimi → `AGENTS.md`），以该目录为 cwd 拉起 CLI，调用结束后清理——被桥接的 agent 零配置拿到记忆协议。

写入入口（`previously ingest`，外部 agent 的唯一写通道；调用方从不直接写 memory 目录，校验全部通过后由 client 的 writer 落盘）。三种模式：`--source <四家之一> [--root <dir> | --path <file>]` 原始日志模式——把会话日志（或整目录/单文件导出）交给 scribe 同一条转录管线解析、切片、落盘，纯本地零 token；`--submit <file|->` 成稿模式——调用方（通常是自己处理完对话的 agent）提交一份完整 slice 文档，严格校验（frontmatter 必填 `slice_id`（与 start 分钟绑定）/`status: closed`/ISO `start`/`end`/`source`/`session_id`，`## Turn <id> — <ISO> (user|agent)` 正文、时间戳单调、单行标量），任何一项违反即整单拒绝并输出完整 issue 清单，通过后按内核 canonical 形状重新渲染落盘；按 `(source, session_id)` 去重（同内容重交幂等跳过、不同内容硬性冲突绝不覆盖），分钟冲突自动步进并告知 remap。摄入的历史 slice 不触发卡片演化、不写 per-slice 卡片快照/认知记录。两个可选的 token 消耗项都先估账、确认后才花：`ingest --mark`（对每个 dry slice 调一次 bridge 大脑填 focus/summary/tags（线索）；不带 `--yes` 只打印「N 片 → N 次调用」的估计，一次 `--yes` 覆盖一批）；`card bootstrap`（前情提要冷启动：`--empty` 零消耗写空骨架；默认基于物理时间最近 7 天的 slice 一次调用生成；`--full` 全量须先看到估算与警告再 `--yes`；调用经 `PREVIOUSLY_BRIDGE_*` / config 的 bridge 大脑，走用户既有订阅，client 不碰 API key）。

感知末梢（设计文档 §5，批次 C3 + C6）：Scribe 抄录器用 chokidar 监听四家会话日志——`~/.claude/projects/**/*.jsonl`（Claude Code）、`~/.codex/sessions/**/*.jsonl`（Codex）、`~/.kimi-code/sessions/**/wire.jsonl`（Kimi Code）、`~/.gemini/tmp/*/chats/*.json`（Gemini CLI）——按字节偏移量 + 链式内容 hash 的增量游标（`~/.previously/scribe/cursors.json`，原子写入）把会话日志转录为与内核同构的时间片：`memory/episodic/slices/YYYY/MM/DD/HHMM/timeline/core.md` + 月度 `_index.json`（条目带 `source` / `sessionId` 来源标签）。解析按家隔离成插件（`src/scribe/parsers/`）；格式漂移的行不中断管线，降级为 `timeline/appendix.md` 原文附录并计入 parse errors（§5.3 格式税）。截断/轮换检测（文件变短即从 0 重读），重启从游标恢复，重复转录字节级幂等。Kimi 的 session id 从路径推导（`session_<uuid>/<agent>`，含子代理 wire）；Gemini checkpoint 是整文件 JSON 重写（非 append-only），按内容 hash 判定变化、每次全量重推导、slice 原地生长，retention 清理中途删文件走 unlink tombstone，不崩不报；未验证格式一律以 ASSUMED fixture 测试标注。`previously watch` 前台运行（`start` 会以独立 detached 进程自动拉起，自带 pid 文件与日志；`stop` 两者皆停；`status` 报告每个来源的文件数/事件数/最后事件时间/解析错误数）；`previously scribe once [--source claude-code|codex|kimi-code|gemini]` 一次性全量扫描，用于回填与调试。稳定性加固（C6）：watch 进程注册 `unhandledRejection` 兜底（如实写入 scribe 状态文件与日志，不静默崩退），watcher 对 root 出现/消失容错重挂；`status` 退出码反映最差子系统（内核健康但 scribe 已死、或 scribe 有记录错误 → 非零）；内核与 scribe 日志在拉起时按大小轮转（>10MB → `.1` 改名，保留 3 份）。

## 支持矩阵（verified = 本机真实数据/真实 prompt 验证；assumed = 无 ground truth，fixture 测试覆盖）

| Agent | Scribe 数据源 | Scribe 格式状态 | Bridge 后端 | Bridge 状态 |
|---|---|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | verified（真实会话日志） | `claude -p --output-format stream-json` | verified（2.1.204 真实 prompt） |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | assumed（无官方 schema，无本机二进制） | `codex exec --json` | assumed（本机无二进制，fixture CLI 覆盖） |
| Kimi Code | `~/.kimi-code/sessions/**/agents/*/wire.jsonl` | verified（82 个真实 wire.jsonl，protocol 1.5） | `kimi -p --output-format stream-json` | verified（0.34.0 真实 prompt） |
| Gemini CLI | `~/.gemini/tmp/*/chats/*.json` | assumed（无本机安装；整文件 JSON checkpoint） | —（设计文档 §7 不含 Gemini 桥接） | n/a |

订阅桥接（设计文档 §7，批次 C4）：`previously bridge-exec` 是内核 delegateTask 工具（agent 仓库 client mode，`PREVIOUSLY_BRIDGE_CMD`，默认 `previously bridge-exec`）的本地执行端，契约严格对齐：stdin 收 `{"task","context"}` JSON → 路由到适配器（`--agent claude|codex|kimi`，否则取内核每次调用注入的 `PREVIOUSLY_BRAIN_AGENT` 环境变量，再缺省取 config `executionBackend`，`previously init --backend ...` 设置）→ stdout 输出最终纯文本结果，exit 0 成功；失败一律非零退出 + stderr 诊断（§9 失败哲学：CLI 缺失 / 鉴权或配额报错原文 / 超时 / 流格式漂移，绝不伪造输出；exit 0 必伴随非空 stdout，否则内核视为 malformed）。三家适配器接口对齐（`dispatch({task, context}) → result text`）：Claude 走 `claude -p --output-format stream-json --verbose --max-turns N`（prompt 经 stdin 传入，避开 Windows argv 长度限制；N 默认 25，`PREVIOUSLY_BRIDGE_CLAUDE_MAX_TURNS=none` 关闭），Kimi 走 `kimi -p <prompt> --output-format stream-json`，Codex 走 `codex exec --json <prompt>`；三家统一经临时工作目录注入记忆 skill（见上文「能力出口」：claude → `CLAUDE.md`，codex/kimi → `AGENTS.md`）。鉴权全部使用用户既有订阅 OAuth，client 不碰 API key。超时默认 9.5 分钟（略低于内核 delegateTask 默认 10 分钟，保证适配器先给出如实超时错误），`PREVIOUSLY_BRIDGE_<AGENT>_TIMEOUT_MS` / 全局 `PREVIOUSLY_BRIDGE_TIMEOUT_MS` 可调；bridge-exec 收到 SIGTERM/SIGINT 会转发杀死子进程。每家 CLI 可用 `PREVIOUSLY_BRIDGE_<AGENT>_CMD` 覆盖（可带额外前导参数，如 `PREVIOUSLY_BRIDGE_KIMI_CMD="kimi --auto"`）；`previously status` 展示 backend 与三家 CLI 的 PATH 探测结果（如实报 not found）。flag 与流格式假设：claude 2.1.204 与 kimi 0.34.0 已在本机真实验证（最小 prompt 各一次）；codex 本机无二进制，形状属假设、由 fixture CLI 测试覆盖。全部测试使用模拟各家 stream-json 输出的 fixture CLI（`tests/bridge-fixtures.ts`），e2e 通过真实构建的 `dist/cli.js bridge-exec` 逐字节验证内核契约。
