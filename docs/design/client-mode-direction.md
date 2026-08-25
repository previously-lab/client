# Previously 产品方向：Cloud-first + Client 作为本地适配器

> 整理时间：2026-08-22（2026-08-25 修订，见 §9）
> 适用分支：
> - client: `feature/client-mvp`
> - agent: `feature/v0.9-client-mode`
> 当前状态：bridge 协议 2、单模型重构、事件流、per-agent 配置、阶段外包均已提交（agent 仓 `feature/v0.9-client-mode`）；下一步是 BYOK 路径与合并 release。

---

## 1. 核心产品定位

**Previously 首先是一个云端个人记忆助手。**

用户的核心体验应发生在浏览器中，连接部署在 Vercel / 云端的 Previously 服务。记忆模型、workflow、进化逻辑、Web UI 全部以云端/edge 为 first-class。

Client（本地 CLI + kernel）不是"Previously 的本地版"，而是：

1. **本地 kernel 启动器**：为完全离线/隐私敏感用户提供本地跑全套 Previously 的能力；
2. **Bridge 兜底安装器**：为没有 API key 的用户提供一条"残血但能聊"的本地订阅 CLI 路径；
3. **可选增强**：未来可能从 Previously 向本地 agent 派发任务，但当前不急着做。

---

## 2. 双轨引擎：agent 外包默认，BYOK 推荐

Client 模式提供两种引擎，**都可选**，模式即所选模型：

1. **本地 agent 外包（默认）**：`bridge/claude|codex|kimi`，无需 API key，开箱即聊。用户刚上手时大概率没有 key，这是默认路径。
2. **BYOK（推荐）**：用户自带 API key 直连。体验最完整——流式、快、无 CLI 冷启动，能提供 Previously 的全部能力。

- BYOK 体验最好（走 API，流式、可控、快）；
- 我们不需要替用户承担 API 成本；
- 与云端 Previously 的体验保持一致。

Client 本地 kernel + BYOK API ≈ 一个自托管的 Previously 实例；本地 agent 外包则是零门槛的入口。

---

## 3. 本地 agent 外包模式：默认路径，持续打磨

Bridge 模式（`bridge/claude`、`bridge/codex`、`bridge/kimi`）的定位是：

> **没有 API key 的用户的默认上手路径。**

### 3.1 接受它的天花板

- 每次模型调用都是一次 CLI 冷启动；
- 非流式（或有限流式），要等进程退出；
- 多轮工具循环会被放大成多次 spawn；
- prompt 注入/技能冲突无法根除。

这不是实现问题，是 Claude/Codex/Kimi CLI 作为"客户端"而非"推理引擎"的结构性限制。想要完整体验，引导用户切 BYOK。

### 3.2 做什么

- 保留并维护当前 bridge 适配（`bridge-model.ts`、协议 2、事件流、per-agent 配置）；
- **保留阶段级外包**（`bridge-phases.ts`，housekeeping 整阶段一次 CLI 调用）：它是 agent 外包模式的实现方式，experimental，有 kill-switch `PREVIOUSLY_PHASE_OUTSOURCE=0`；
- 修最影响观感的 bug（如 bridge 事件渲染成原始 JSON）；
- 在 UI 里标识 bridge 为默认上手路径，同时引导用户配置 BYOK 获得完整能力；
- BYOK 模型被选中时，阶段外包自动关闭，housekeeping 走标准 API 子代理路径。

### 3.3 不做什么

- **不再做常驻 Claude 实例 / TUI scraping**；
- **不再追求 bridge 与 API 模式体验一致**（BYOK 才是完整体验的路径）。

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
2. ~~client 默认模型改回 API/云端模型~~（作废，见 §2：bridge 为默认上手路径）；
3. bridge 选项保持默认，BYOK 选项加"推荐"标识；
4. 简单文档说明双轨：bridge 默认上手，BYOK 推荐完整体验。

### 5.3 回归云端主线

1. 确保 API 模式（edge/cloud）是默认、推荐、体验最好的路径；
2. 把主要精力放回云端 Previously 的核心体验（记忆召回、workflow、UI）。

---

## 6. 中期方向

1. **Cloud-first**：核心功能先在 edge/cloud 跑通，client 只是镜像；
2. **双轨引擎**：agent 外包默认上手，引导用户配置 BYOK 获得完整能力（见 §2）；
3. **Client 薄化**：client 只负责启动本地 kernel、安装 bridge、指向本地或云端服务；
4. **记忆分层**：给 coding agent 的记忆应严格限制在工作相关范围，避免泛情境记忆稀释专注力；
5. **Outbound agent 委派 backlog**：保留"从 Previously 向本地 agent 派任务"的想法，但当前不实现。

---

## 7. 明确不做（避免再次摇摆）

- 不把 Claude/Codex/Kimi 当 Previously 内核（阶段外包是把它们当"外包执行者"，内核仍在 Previously 侧校验与落盘，不算违反此条）；
- 不做常驻 CLI 实例 / TUI scraping；
- 不做 heavy skill-pack 架构（阶段外包的单阶段单调用 + zod 校验报告不属于此类）；
- 不做 Previously Code / coding agent 专用记忆层；
- 不做云端 → 本地 agent 的远程连接（当前阶段）。

---

## 8. 备注

- 当前 agent 仓已合入 main 的 0.8.1 + v0.9 重整（merge commit `f3398c0`）；
- client 仓的 `dev.env` 已 gitignore，提交时注意不要把 key 带上；
- 提交信息用英文 conventional commit，不 push。

---

## 9. 修订记录

### 2026-08-25：双轨引擎确立

讨论后推翻本文 8/22 版的两条结论：

1. ~~"BYOK 是 client 主推模式、bridge 只作兜底、默认不选 bridge"~~ → **双轨制**：agent 外包是默认上手路径（用户一开始大概率没有 key），BYOK 是推荐的完整能力路径，两者并列可选（§2 已改写）。
2. ~~"不再做 skill-pack 编排/阶段外包"~~ → **阶段级外包保留**（agent 仓 `587e52c`），它是 agent 外包模式的核心实现，experimental + kill-switch；BYOK 模型被选中时自动绕过。

同时期 agent 仓进展：bridge 协议 2、单模型重构、worker 双轨移除、阶段外包均已提交在 `feature/v0.9-client-mode`（12 提交，测试 955 全过）；§5.1"锁住现有成果"已完成。
