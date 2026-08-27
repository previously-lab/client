# Previously Client 0.9.0 发布前全链路验证报告

日期：2026-08-27 · 验证环境：Windows 11 + Git Bash，Node v24.18.0，pnpm 11.10.0，npm 11.16.0 · 执行：Kimi Code（本机模拟）

> 验证对象：client 仓库工作区状态（HEAD `24b38c8` + 未提交改动 12 文件，含新增 `src/lib/ansi.ts`）打包产物；内核为 Aftrbrez `7f7b796` 的 `build:standalone` 产物（APP_VERSION 0.9.0）。
> 隔离方式：全程使用独立 `PREVIOUSLY_HOME`（`client/.e2e/home*`）与端口 3217-3221，用户真实实例（`~/.previously`，端口 3210）未受影响。
> **状态：初测发现的全部缺陷已于同日修复并复测通过，见文末「修复记录」。**

## 结论总览

**打包 → 安装 → 初始化 → 内核安装 → 启动 → Web UI → bridge/BYOK 双大脑真实 chat 轮次 → 停止，全链路打通。** 初测发现 1 个高严重度缺陷（BYOK 主 chat 必败）+ 2 个 client 缺陷 + 若干 UX 问题，**当日全部修复并端到端复测转绿**（最终 packaged e2e 4/4 通过，client 单测 551 通过，内核单测 1008 通过）。剩余为非阻断项：供应链重量（首装需 git+pnpm 本机构建）、若干文档/体验建议。

## Phase 1 — 打包产物（npm pack）✅

- `pnpm pack` 产出 `previously-client-0.9.0.tgz`（112KB）：60 个 dist 文件 + package.json + README，无多余内容。
- `dist/cli.js` shebang 完整；dist 内无对 `src/` 的运行时引用（仅注释字符串）。
- `npm i -g <tarball> --prefix <隔离目录>` 安装成功，`previously.cmd` shim 正常：`--version`/`--help`/裸命令均可。
- 注意：`--pack-destination .` 相对项目根而非 cwd（pnpm 行为，非缺陷）。

## Phase 2 — 内核构建与安装 ✅

- `pnpm build:standalone` 成功；pack-standalone 解引用 34 个 symlink，拷贝 `.next/static` 与 `public/`。
- 出厂审计：standalone 产物 4478 个文件、**零 symlink**（§10.1 v5 标准达成）；`server.js` 入口存在。
- `kernel install --from <dir> --version 0.9.0` 安装成功，指针/marker 正确；`--version 0.9.1` 被拒绝（exit 1，文案清晰）；同版本重复安装拒绝（exit 1）。

## Phase 3 — CLI 真实使用链路（打包产物）✅

- 空 home 裸命令（非 TTY）：自动 init + 真实转录本机日志（claude 225 文件 36972 事件、kimi 203 文件 37348 事件，**0 解析错误**）。
- `init --backend kimi` → 写 brain=bridge/kimi；`start`（端口 3217）→ `/api/version` 返回 `{"version":"0.9.0","mode":"client"}`；`status` 完整报告；`logs`/`stop`/二次 `stop`/重启循环全部正常，pid 文件清理干净。
- `install --kimi`/`uninstall --kimi` 对真实 `~/.kimi` 对称投递与移除，无残留。
- 观察项：watch 日志出现 `PromiseRejectionHandledWarning`（有 promise 先 rejection 后挂 handler，C6 兜底能接住但有日志噪音）；init 摄入后 `previously timeline` 报 not_found（顶层 timeline.md 由内核生成，scribe/ingest 只写 slices + 月度索引——行为如实但状态面板若推荐 reader 命令会误导新用户）。

## Phase 4 — Web UI E2E（打包产物）✅ 4/4 通过（修复后终验）

方法：给 Aftrbrez `playwright.config.ts` 加 `E2E_EXTERNAL_BASE_URL` 开关（设了就跳过内建 dev server，直接打外部实例），新增 `tests/e2e/packaged.spec.ts`（serial，4 个测试），目标实例由**打包后的 client**（`previously start`，scratch home，端口 3217）拉起。改动均未 commit。

| 测试 | 初测 | 终验 |
|------|------|------|
| standalone 渲染与资源完整性（`/en`、`/en/settings`，全部响应无 ≥400） | ✅ | ✅ |
| BYOK 表单自动保存落盘 scratch config.json + `/api/models` 热列出 `byok/deepseek-chat` | ✅ | ✅ |
| BYOK 真实 chat 轮次（deepseek-chat，最小 prompt） | ❌ BUG-0 | ✅（23.4s，真实 DeepSeek 返回 "OK"） |
| bridge 真实 chat 轮次（kimi 订阅，最小 prompt，返回含 "OK"） | ✅ | ✅ |

### BUG-0（高）：BYOK 主 chat 轮次必败 —— 已修复并复测通过 ✅

- 初测页面表现：housekeeping/evolution 正常，主回复失败——内联错误 "The turn failed with an unexpected error."；服务端日志 `AI_LoadAPIKeyError: OpenAI API key is missing`（workflow step `doStreamStep` 重试 3 次后冒泡）。
- 根因（已实测确认，**非打包特有问题**）：BYOK 模型经 `createOpenAI({baseURL, apiKey})` 构造，apiKey/baseURL 只存在于闭包/headers，model 实例 `config` 上没有；跨 workflow→step 序列化边界丢失，step 侧 `rebuildOpenAIModel` 读不到，回退读 `OPENAI_API_KEY` env → standalone 下没有 → 报错。sub-agent（evolution 等）不过序列化边界所以正常——只有主 chat 挂，极易被局部测试漏掉。
- 修复（Aftrbrez，未 commit）：`src/lib/models/provider.ts` openai 分支在显式 apiKey（BYOK）时把 apiKey/baseURL 作为 JSON 安全字段重挂到 `model.config`，step 侧原样读回；env-key 模型（云端路径）刻意不动。新增 `tests/app/api/agent/register-model-classes.test.ts` 真实序列化往返测试；`registry.ts`/`register-model-classes.ts`/`AGENTS.md` 的错误注释同步更正。
- 安全注记：序列化 payload（含 key）只落盘在本地 `.workflow-data/`，不进任何 HTTP 响应/日志；已在代码注释声明这一权衡。
- 遗留：env-key 的 openai 路径模型（云端 Kimi/Qwen 等）跨 step 边界仍回退 `OPENAI_API_KEY`——既有行为，云端要用需另行处理。
- spec 附带发现：模型选择器 popover 选中后不自动关闭（uncontrolled），spec 内用 Escape 绕过；turn 失败走内联相位而非 ErrorBanner；测试期间内核 evolution 会往 scratch home 的 memory 写认知记录（预期行为）。

## Phase 5 — 对抗性测试

| # | 探针 | 结果 | 分类 |
|---|------|------|------|
| 1 | 端口被无关 HTTP 服务占用后 `start` | ✅ 干净拒绝，文案可操作 | 通过（`status` 显示 "Port reachable" 有歧义，见 UX-1） |
| 2 | `kernel.pid` 写入无关活 pid | ❌ `start` 误报 "already running"、`status` 误报 running（`isProcessAlive` 只探活不验身份） | **BUG-1（中）→ 已修复** |
| 3 | `current.json` 非法 JSON | ⚠️ 抛原始 JSON 错误（"Expected property name…"），非可操作文案 | UX-2（低）→ 已修复 |
| 3b | 指针悬挂（版本目录被删） | ✅ 三选一可操作报错 | 通过 |
| 4 | 同版本重复 `kernel install` | ✅ exit 1（复核：README:47 描述的是 dev.mjs 行为，`scripts/dev.mjs:172` 确实先清旧目录——初判的"文档不符"为误报） | 通过 |
| 5 | 连续两次损坏 config 跑 doctor | ❌ 第二次修复覆盖 `.bak`，原始配置备份丢失（`config-doctor.ts:129-134` 用 copyFileSync 而非 backupOnce 语义） | **BUG-2（中低）→ 已修复** |
| 6 | `init --force` 已有 apiKeys/agents 调优 | ❌ 无备份直接清空 | UX-3（中低）→ 已修复 |
| 7 | `PREVIOUSLY_HOME` 含中文+空格全链路 | ✅ init→start→API→stop 全通 | 通过 |
| 8 | `PREVIOUSLY_HEALTH_TIMEOUT_MS=abc` | ⚠️ 报 "did not respond within NaNms"，内核实际健康但被判超时并留置运行（`stop` 可回收） | UX-4（低）→ 已修复 |
| 9 | 双 `watch` / init 中断半成品恢复 | ✅ 第二个 watch 拒绝；半成品 home 可续 init | 通过 |
| 10 | bridge-exec 运行中收 SIGTERM | ✅ 子进程被转发杀死；⚠️ 临时 workspace 残留（Windows 上 SIGTERM=TerminateProcess 立即杀死，finally 清理不会执行；且发现 8/24 真实使用遗留的 `previously-bridge-TReJ3z`，证明泄漏真实发生） | UX-5（低）→ 已修复（启动清扫） |
| 11 | apiKeys 值含换行/引号/中文注入内核 env | ✅ 内核正常启动 | 通过 |
| 12 | 内核安装 staging 残留目录 | ✅ 不阻碍重装 | 通过 |
| 13 | **BYOK 引擎选择被 doctor 撤销**（修复期发现）：Web UI 选 BYOK 会清空 brain，但下次 `start` 的 doctor "brain missing while backend is X" 修复会重新写入 bridge brain，用户引擎选择被静默改回 bridge | ❌ client↔内核契约冲突 | **BUG-3（中高）→ 已修复**（doctor 见到 `byok` 段即不再补 brain；`PreviouslyConfig` 增加 `byok` 透传字段） |

## 静态探查发现（代码审阅，验证期复核）

1. **`PREVIOUSLY_DEFAULT_MODEL` 是 dead env**：client `kernel-env.ts:52` 注入，内核全仓无消费点；api-key 大脑的默认模型契约未闭环（默认模型取可用列表第一个）。
2. **设计 §10.1 v5「内核 npm 包分发、用户机器永不编译」未实现**：当前默认供应链要用户机器有 git + pnpm + 网络克隆 GitHub tag 并本机构建——对目标用户（不想部署的人）门槛过高。本次验证走了 `--from` 逃逸通道。
3. **`tasks/`、`sessions/`、`.workflow-data/` 落盘在 kernel 版本目录 cwd**：升级换版本后这些数据不迁移（kernel-env 只重定向 `memory/`）。
4. **standalone 下 `.claude/skills`、`.agents/skills` 发现静默为空**（existsSync 守卫，不报错但技能消失）。
5. 设计文档 §2 残留已退役的 `previously upgrade`/`recall`；仓库声明 MIT 但无 LICENSE 文件。
6. git-URL 安装（`npm i -g github:...`）会触发 `prepare` 需要 pnpm+typescript——registry 安装无此问题，但 README 若给 git 安装方式需注意。

## 修复记录（2026-08-27，当日完成）

**内核（Aftrbrez，改动未 commit）**：
- **BUG-0**：`src/lib/models/provider.ts` openai 分支在显式 apiKey（BYOK）时将 apiKey/baseURL 重挂到 `model.config` 的可序列化字段；注释更正（`register-model-classes.ts`、`registry.ts`、`AGENTS.md`）；新增 `tests/app/api/agent/register-model-classes.test.ts`（真实 `@ai-sdk/openai` 序列化往返）；`tests/lib/models/provider.test.ts` fixture 对齐真实 SDK。验证：`pnpm test` 1008 通过；packaged e2e BYOK 真实轮次转绿。

**client（本仓库，改动未 commit）**：
- **BUG-1**：pid 文件升级为两行格式（pid + 命令行 marker 子串）。`process.ts` 新增 `processCommandLine`（win32 走 PowerShell CIM / POSIX 走 `ps`）与 `checkPidFile`（none/stale/foreign/running 四态）；`start`/`stop`/`status`/`open`/`watch` 全部改走 `checkPidFile`——`stop` 绝不会 taskkill 无关进程，pid 复用误判消除。旧格式（裸 pid）自动降级为原有探活语义，向后兼容。
- **BUG-2**：`config-doctor.ts applyAudit` 改为 backupOnce（`.bak` 已存在则不覆盖）。
- **BUG-3**：`config.ts` 增加 `byok` 透传字段；`config-doctor.ts` 的 brain 补推导在 `byok` 段存在时跳过——Web UI 的 BYOK 引擎选择不再被 `start` 撤销。
- **UX-1**：`status` 的 Port 行在内核未运行但端口被占时明示 "another process is listening"。
- **UX-2**：`kernel.ts readCurrentPointer` 对非法 JSON 给出可操作文案（重装或删文件 + kernelDir 覆盖）。
- **UX-3**：`init --force` 覆盖前备份一次 config 到 `.bak`。
- **UX-4**：新增 `src/lib/env.ts parseMsEnv`——`PREVIOUSLY_HEALTH_TIMEOUT_MS`/`PREVIOUSLY_STOP_TIMEOUT_MS`/`PREVIOUSLY_SCRIBE_RESCAN_MS` 垃圾值回退默认，不再出现 "NaNms"。
- **UX-5**：`skills.ts sweepStaleBridgeWorkspaces`——bridge-exec 每次调用前清扫超龄（24h）`previously-bridge-*` 临时目录（硬杀残留的真实出口）。
- 新增回归测试 11 个（kernel/config-doctor/init/kernel-supply/skills + 新建 env.test.ts）。验证：`pnpm lint` 干净，`pnpm test` **42 文件 551 通过 1 跳过**；重新打包安装后 `start→status→stop` 冒烟通过（pid 文件带 marker 正常工作）；终验 packaged e2e **4/4 通过**。
- **A2**：`previously timeline` 在 timeline 尚未生成时（init/ingest 后、内核还没跑过聊天回合，timeline.md 与 index.json 均不存在或内容为空）输出友好提示（"由内核在首个聊天回合后生成，先 `previously start` 聊一轮"）并 exit 0，不再报原始 not_found；过滤器无匹配等真正的 not_found 仍 exit 1。`memory.ts` 新增 `hasTimeline`；timeline 测试 +3。
- **A3**：scribe 的 recordError+writeStatus 二次失败（磁盘满/杀软锁文件）收敛为 `ScribeEngine.recordErrorSafe`（兜底只 console.error），覆盖 enqueue 内层 catch、chokidar error handler、`watch` 的 unhandledRejection 兜底与 rescan 定时器 catch 四处——消除 watch 日志里的 `PromiseRejectionHandledWarning`，队列不再被毒化。scribe-watch 测试 +1。
- **A4**：设计文档 §2/§7.3 清除已退役的 `previously upgrade`/`previously recall` 正文残留（v7 注记保留）；新增 MIT `LICENSE`（copyright previously-lab, 2026，对齐 package.json 声明）；README 快速开始补充 git-URL 安装会触发 `prepare`、需本机 pnpm+typescript 的注记；`PREVIOUSLY_DEFAULT_MODEL` 描述更新为"内核自 0.9.0 起消费：BYOK 段未写 model 时作为默认模型"。

## 体验建议（面向后续工作）

BUG-0/1/2/3 均已修复，发布的主要障碍已清除。剩余按价值排序：

**供应链（已完成，见第二轮）**：§10.1 v5 的内核 npm 包形态已落地——`previously-kernel` 打包/发布管线 + client 默认依赖安装，用户机器零构建。剩余的是发布动作本身（NPM_TOKEN、打 tag、lockfile，见第二轮「发布顺序」）。

**对你后续三个计划的反馈**：
- **memory 改本地化 git 仓库**：方向合理。~~注意一并解决 `tasks/`、`sessions/`、`.workflow-data/` 绑内核版本目录的问题~~——**B1 已解决**：三者已重定向到 `PREVIOUSLY_HOME` 并带旧实例迁移，git 化地基就绪。另外内核直接写 memory 目录会与 git 化产生并发写冲突，建议明确"内核写 → client 定期 commit"的单一写者约定。
- **云端远程连接本地仓库**：本地实例本来就监听 127.0.0.1，远程连接需要鉴权层（当前 `/api/client/*` 只有同源守卫，没有真正的身份验证），设计时把这一点列为前置依赖。
- **Web UI 欢迎页**：强烈需要。当前首次体验断点在"init 完 → start → open 之后面对空聊天框"。欢迎页文案可以先复用设置页已有的 bridgeHint/byokHint 措辞；BUG-0 已修复，"推荐配 API key、bridge 作为先行体验" 的引导现在成立。

**契约闭环（已完成，见第二轮 A1）**：`PREVIOUSLY_DEFAULT_MODEL` 内核已消费——BYOK 段缺 model 时作为默认模型，BYOK-only 部署不再落到用户没配 key 的内置模型。

**回归基建**：本次的 `packaged.spec.ts` + `E2E_EXTERNAL_BASE_URL` 开关已留在 Aftrbrez 仓库（未 commit），建议保留并纳入发版检查单：`pnpm pack` → 隔离安装 → kernel install → start → `pnpm test:e2e`（external 模式）。Phase 5 探针中可固化的场景（pid 复用、`.bak` 保护、env 垃圾值、workspace 清扫、corrupt 指针）已全部落成 vitest 用例。

## 第二轮：遗留修复与供应链落地（2026-08-27，同日完成，全部未 commit）

按「P0 契约闭环与小修 → P1 状态迁移与可观测性 → P2 供应链」执行，终验全部转绿。

**内核（Aftrbrez）**：
- **A1 `PREVIOUSLY_DEFAULT_MODEL` 契约闭环**：`parseByok`（迁至新模块 `src/lib/byok-parse.ts`）在 byok 段缺 model 时回退该 env；`registry.ts getDefaultModelId()`/`getModel()` 增加 BYOK 感知（无 env-key 模型时默认落到 `byok/<model>` 而非用户没配 key 的 `ALL_MODELS[0]`）。同步读配置走 `src/lib/byok-sync.ts`（`process.getBuiltinModule` 运行时解析 fs，**不静态 import node builtins**——静态 import 会让 client-config 被拉进 workflow bundle，构建报 `workflow-node-module-error`，修复期实测复现并如此解决）。测试 +8。
- **B1 内核半**：`whitelist/index.ts resolveLocalDataPath` 增加 `tasks/`→`TASKS_ROOT`、`sessions/`→`SESSIONS_ROOT` env 重定向（缺省落 cwd，行为不变）。whitelist 测试 +8。
- **B2 env-key openai 跨 step 边界**：`provider.ts` env-key 分支在 `WORKFLOW_TARGET_WORLD === 'local'` 时同样把解析到的 apiKey/baseURL 重挂 `model.config`（安全权衡同 BUG-0，只落本地盘）；非 local（云端）保持回退 env 并在注释说明。register-model-classes 测试 +2。
- **B3 内核半**：skills 发现支持 `PREVIOUSLY_SKILLS_DIR` 追加目录；`syncDiscoveredSkills` 增加发现结果日志（0 个时提示可往 env 目录放置）。测试 +7。**注意**：`src/lib/skills/registry.ts` 目前在内核 src 内**没有任何 importer**（Open Agents 移植后未接线），本次只完成 env 支持与可观测性，接线归属（如 chat 斜杠命令自动补全）待产品决策。
- **B4**：`model-selector.tsx` Popover 改受控（`open`/`onOpenChange`），选中后自动关闭。内核无组件渲染测试基建，该行为由 packaged e2e 覆盖。
- **C0 产物瘦身与打包**：`next.config.ts` 加 `outputFileTracingExcludes` 剔除误 trace 的 `memory/`、`benchmark-data/`（standalone **96M → 74.3M**，已用 12M 真实 memory 数据全保真验证剔除机制）；`pack-standalone.mjs` 加体积摘要；新增 `scripts/pack-kernel.mjs` + `pnpm pack:kernel`——产出 npm 包目录 dist-kernel（实测 tgz **18M** / 3925 文件，version 取 APP_VERSION）；新增 `.github/workflows/release-kernel.yml`（tag `v*` → build:standalone → pack:kernel → `npm publish --provenance`，上游仓库门控仿 bump-version.yml；**需在仓库配置 `NPM_TOKEN` secret**）。

**client（本仓库）**：
- **B1 client 半**：`kernel-env.ts` 注入 `TASKS_ROOT`/`SESSIONS_ROOT`/`WORKFLOW_LOCAL_DATA_DIR`/`PREVIOUSLY_SKILLS_DIR`（全部落 `<home>/`）；`start.ts` 启动前一次性迁移内核版本目录里遗留的 `tasks/`/`sessions/`/`.workflow-data/` 到 home（目标已存在则两边保留并提示，rename 失败降级警告不阻断）；`init` 创建 `<home>/skills`。测试 +6（migrate-data-dirs.test.ts 新文件 4 例等）。
- **C-A 供应链默认路径**：`kernel install` 默认改为 `installFromDependency`——`createRequire` 解析 pinned `previously-kernel` 依赖的 `standalone/` 直接安装（版本 = 依赖包版本，与 pin 做 checkCompat），用户机器零构建零外部工具；`--from` 逃逸通道保留；原 git clone + pnpm build 降级为显式 `--repo [url]` 开发者通道；依赖路径下传 `--version` 直接拒绝。`package.json` dependencies 新增 `previously-kernel@0.9.0`（**lockfile 刻意未更新，见「发布顺序」**）。测试 +10（kernel-dependency.test.ts）。

**文档**：README 内核供应链段改写为依赖安装默认 + 双逃逸通道；设计文档 §10.1 增补「v5 落地状态（0.9.0，已实现）」。

**终验（2026-08-27 实弹）**：client lint 干净、**44 文件 569 通过 1 跳过**；内核 **88 文件 1033 通过**、主树 `pnpm build:standalone` 全绿（workflow bundle 内零 node builtin，实证）；双 tarball 隔离安装（`npm i -g previously-client.tgz previously-kernel.tgz`）→ init → `kernel install`（新默认依赖路径）→ start → `/api/version` 0.9.0 → status → stop 全通；packaged e2e **4/4 通过**（BYOK 真实轮次 42.3s、bridge/kimi 1.2m）；升级演练：旧式 home（数据目录在 kernel 版本目录内）start 后三个目录连内容迁移到 home、内核目录零残留；真实聊天回合后 `.workflow-data` 落在 home 而非内核目录，重定向生效。

**发布顺序（用户操作，有先后依赖）**：① 在 previously-lab/agent 仓库配置 `NPM_TOKEN` secret；② 打内核 tag 触发 release-kernel.yml 首发 `previously-kernel@0.9.0`（npm 包名需可用）；③ client 仓库 `pnpm install` 更新 lockfile 后恢复 `pnpm lint/test` 包装命令（目前 pnpm 的 deps-status 检查会因包未发布 404，绕过方式：直接调 `node_modules/.bin` 下的 tsc/vitest——本轮验证就是这么跑的）；④ 再发 client。client CI 的 frozen-lockfile 在 ③ 之前会失败，属预期。

## 第三轮：memory 本地化 git 仓库（2026-08-27，同日完成，全部未 commit）

设计文档 v8 落地：memory 目录升级为本地 git 仓库，写入语义与云端 `STORAGE=github` 精确对齐。

**内核（Aftrbrez）**：新增 `src/lib/episodic/local-git.ts`——`<MEMORY_ROOT>/.git` 特征检测激活（零新契约，非仓库目录行为不变）；`io-helpers.ts` 接线：裸写 = 单文件单 commit（`Update <path>`），`flushBatch` = N 文件 1 commit（对齐 github 节奏）；`config/actions.ts` 的 user/config.json 同样挂 commit。实现用 isomorphic-git 纯 JS（零外部工具）；commit 失败 warn-and-continue 绝不阻断写入（fs 是事实源，git 是账本）。新增 9 个测试（真 git 仓库）。构建实证：isomorphic-git 未进入 workflow bundle（构建绿 + 产物 chunk grep 验证）。

**client（本仓库）**：`defaultMemoryRepo()`（`~/Documents/Previously` 优先、回退 `~/Previously`，PREVIOUSLY_HOME 下沙盒化）；新增 `src/lib/memory-repo.ts`（`ensureMemoryRepo` 四态：创建/空目录初始化/领养/非空非 git 拒绝；`commitAll`；`repoSummary`）；init 向导与 `--memory-root` 默认走仓库语义、改链领养已有 Previously 仓库；doctor 新增 memory repo 审计（缺失重建/缺 `.git` 补 init/异质目录只警告）；status 面板新增 Memory repo 行；scribe（watcher 批次/once）、ingest（三模式）、stop（Sweep 兜底）接 commit。**终验中抓到并修复**：`repoSummary` 原来把"git 读取瞬时失败（另一进程正在 commit）"误报为 "not a git repository"——新增 `busy` 状态区分，status 如实显示"temporarily unavailable"。新增 34 个测试。

**端到端实弹（隔离 home + 双 tarball 隔离安装）**：init 后仓库带 `Initialize Previously memory repository` 首次 commit；scribe 自动转录真实日志产生 `Scribe: 327 slice(s) from claude-code, kimi-code` 批次 commit；BYOK 与 bridge 两个真实 chat 回合各产生 `Turn <id> — housekeeping` + `Turn <id> — agent response` 两个 commit（与云端节奏一致，含 `Update user/config.json` 裸写 commit）；回合后残留的未提交文件由 `stop` 的 `Sweep: uncommitted changes` 兜底收编；改链演练：`cp -r` 仓库到新路径 → `init --memory-root` 领养成功（历史保留）、内核启动正常、`previously timeline` 读到 329 个 slice。packaged e2e **4/4 回归通过**（BYOK 39.4s、bridge 35.5s）。

**发布注意**：client 的 `pnpm-workspace.yaml` 里有临时 override（`previously-kernel: link:../Aftrbrez/dist-kernel`）供内核发布前开发联调，**内核发布后须移除**；`pnpm-lock.yaml` 本轮首次更新（isomorphic-git + link 依赖）。

## 复现与证据

- 测试环境残留：`client/.e2e/`（tarball、隔离 prefix、各 scratch home、探针脚本），已加入 `.gitignore`，可随时整目录删除。
- 内核修复 diff 与 packaged e2e 基建留在 Aftrbrez 工作区（未 commit，按约定）：`playwright.config.ts`、`tests/e2e/packaged.spec.ts`、`src/lib/models/provider.ts`、`src/lib/byok-parse.ts`、`src/lib/byok-sync.ts`、`src/lib/episodic/local-git.ts`、`scripts/pack-kernel.mjs`、`.github/workflows/release-kernel.yml` 等（完整清单见 `git status`）。
- client 全量测试：46 文件 601 通过 1 跳过；内核全量测试：89 文件 1042 通过。
- 真实实例 `~/.previously`（端口 3210）全程未受影响。
