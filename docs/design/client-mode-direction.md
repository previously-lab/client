# Previously 产品方向：Cloud-first + Client 作为本地适配器

> 整理时间：2026-08-22
> 适用分支：
> - client: `feature/client-mvp`
> - agent: `feature/v0.9-client-mode`
> 当前状态：两仓均有大量未 commit 改动（bridge 协议 2、单模型重构、事件流、per-agent 配置等），需先提交并封存，再回归云端主线。

---

## 1. 核心产品定位

**Previously 首先是一个云端个人记忆助手。**

用户的核心体验应发生在浏览器中，连接部署在 Vercel / 云端的 Previously 服务。记忆模型、workflow、进化逻辑、Web UI 全部以云端/edge 为 first-class。

Client（本地 CLI + kernel）不是"Previously 的本地版"，而是：

1. **本地 kernel 启动器**：为完全离线/隐私敏感用户提供本地跑全套 Previously 的能力；
2. **Bridge 兜底安装器**：为没有 API key 的用户提供一条"残血但能聊"的本地订阅 CLI 路径；
3. **可选增强**：未来可能从 Previously 向本地 agent 派发任务，但当前不急着做。

---

## 2. BYOK 仍是 client 主推模式

即使在 client 模式下，也优先推荐用户配置自己的 API key（BYOK）。

- 体验最好（走 API，流式、可控、快）；
- 我们不需要替用户承担 API 成本；
- 与云端 Previously 的体验保持一致。

Client 本地 kernel + BYOK API ≈ 一个自托管的 Previously 实例。

---

## 3. Bridge 模式：只保留，不扩展

Bridge 模式（`bridge/claude`、`bridge/codex`、`bridge/kimi`）的定位是：

> **没有 API key 的用户快速上手的"残血体验"。**

### 3.1 接受它的天花板

- 每次模型调用都是一次 CLI 冷启动；
- 非流式，要等进程退出；
- 多轮工具循环会被放大成多次 spawn；
- prompt 注入/技能冲突无法根除。

这不是实现问题，是 Claude/Codex/Kimi CLI 作为"客户端"而非"推理引擎"的结构性限制。

### 3.2 做什么

- 保留当前 bridge 适配（`bridge-model.ts`、协议 2、事件流、per-agent 配置）；
- 修最影响观感的 bug（如 bridge 事件渲染成原始 JSON）；
- 在 UI 里明确标识"本地订阅桥接（体验受限）"；
- 默认不选 bridge，用户手动选择时才启用。

### 3.3 不做什么

- **不再把 Claude/Codex/Kimi 包装成完整 Previously agent**；
- **不再做 skill-pack 编排**（housekeeping/recall/response/thinkDeep/evolve 全部外包给本地 agent）；
- **不再做常驻 Claude 实例 / TUI scraping**；
- **不再追求 bridge 与 API 模式体验一致**。

---

## 4. 远程/本地 agent 连接：先不实现，仅规划

| 能力 | 是否现在做 | 说明 |
|---|---|---|
| 云端 Previously → 本地 Claude/Codex/Kimi | 否 | 需要中间件、长连接、部署环境支持，成本高，先放着 |
| 本地 Previously → 本地 Claude/Codex/Kimi | 可规划，不急 | 目前没有明确使用场景，先记为 backlog |

如果未来要做，使用场景应该是：

> 用户在 Previously Web 里完成讨论/决策，一键把结论作为任务派给本地 agent 执行，结果回写到 Previously 记忆。

当前没有强需求，不投入。

---

## 5. 近期执行计划（下次对话执行）

### 5.1 先锁住现有成果

1. 在 agent 仓提交当前改动（merge main 后的 v0.9 重整 + 单模型 + bridge 协议 2 + 事件流 + UX）；
2. 在 client 仓提交当前改动（协议 2 + per-agent 配置 + flags）。

### 5.2 收尾 bridge fallback

1. 修 bridge 事件渲染：把 `{"sliceId":"..."}` 这类原始 JSON 翻译成人话；
2. client 默认模型改回 API/云端模型；
3. bridge 选项加"体验受限"提示；
4. 简单文档说明 bridge 是"无 API key 时的兜底"。

### 5.3 回归云端主线

1. 确保 API 模式（edge/cloud）是默认、推荐、体验最好的路径；
2. 把主要精力放回云端 Previously 的核心体验（记忆召回、workflow、UI）。

---

## 6. 中期方向

1. **Cloud-first**：核心功能先在 edge/cloud 跑通，client 只是镜像；
2. **BYOK 优先**：引导用户配置 API key，bridge 只作为 fallback；
3. **Client 薄化**：client 只负责启动本地 kernel、安装 bridge、指向本地或云端服务；
4. **记忆分层**：给 coding agent 的记忆应严格限制在工作相关范围，避免泛情境记忆稀释专注力；
5. **Outbound agent 委派 backlog**：保留"从 Previously 向本地 agent 派任务"的想法，但当前不实现。

---

## 7. 明确不做（避免再次摇摆）

- 不把 Claude/Codex/Kimi 当 Previously 内核；
- 不做常驻 CLI 实例 / TUI scraping；
- 不做 heavy skill-pack 架构；
- 不做 Previously Code / coding agent 专用记忆层；
- 不做云端 → 本地 agent 的远程连接（当前阶段）。

---

## 8. 备注

- 当前 agent 仓已合入 main 的 0.8.1 + v0.9 重整（merge commit `f3398c0`）；
- client 仓的 `dev.env` 已 gitignore，提交时注意不要把 key 带上；
- 提交信息用英文 conventional commit，不 push。
