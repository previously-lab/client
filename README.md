# Previously Client

Previously 的本地客户端：同一内核的本地实例 + 本地感知末梢，npm CLI 形态分发。

- 本地运行 Previously 内核（云端 [agent 仓库](https://github.com/previously-lab/agent) 的 standalone 产物）
- 抄录本机其他 AI Agent（Claude Code / Codex / Kimi Code 等）的对话为时间片
- 通过 MCP 向本机 Agent 暴露只读记忆
- 可复用本地已有的 Agent 订阅作为执行后端；~~通过 Connect 接受云端 Previously 的指挥~~（Connect 暂缓封存，见设计文档）

设计文档见 [docs/design/v0.1-client.md](docs/design/v0.1-client.md)。
