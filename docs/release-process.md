# 发布流程（GitHub 流水线）

两个 npm 包（同属 `@previously-lab` org）、两条 tag 流水线，**严格按顺序**：

```
agent 仓库 tag vX.Y.Z  →  release-kernel.yml  →  npm: @previously-lab/kernel@X.Y.Z
client 仓库 tag vX.Y.Z →  release.yml         →  npm: @previously-lab/client@X.Y.Z
```

版本策略（设计 §10.2）：client 与内核精确 1:1 绑定——`package.json` 的
`previously.kernelVersion` 与 `dependencies["@previously-lab/kernel"]` 必须相等，
`scripts/check-release.mjs` 在发布前强制校验。注意校验的是 **client pin 内核**
的相等关系，不是 client `version` 本身——client 可以发 prerelease
（如 `0.9.0-preview.0`）而 pin 稳定内核 `0.9.0`。

## Preview 通道

`release.yml` 从 tag 版本号自动推导 npm dist-tag：版本号含 `-` 时取第一个
prerelease 标识作为 dist-tag（`0.9.0-preview.0` → `--tag preview`），否则
`latest`。因此：

- client 发 `X.Y.Z-preview.N` → 自动进 `preview` dist-tag，**不影响 latest**；
  用户用 `npm i -g @previously-lab/client@preview` 安装。
- client 发稳定版 `X.Y.Z` → 进 `latest`，`npm i -g @previously-lab/client` 即得。
- preview client 照常 pin 稳定内核（`previously.kernelVersion` 保持 `X.Y.Z`，
  不带 prerelease 后缀）——内核只发稳定版。

## 一次性准备（仓库设置）

- agent 仓库：配置 secret `NPM_TOKEN`（npm automation token，对 `@previously-lab` org 有发布权）。
- client 仓库：配置 secret `NPM_TOKEN`（同上）。
- 首发前确认 `@previously-lab` org 已创建、token 对两个 scoped 包都有发布权
  （scoped 包首发必须带 `--access public`，流水线里已固定）。

## 每次发布

1. **先发内核**（agent 仓库）：
   - 推送 tag `vX.Y.Z`（或发布同名 GitHub Release）。
   - `release-kernel.yml` 自动：构建 standalone → 出厂审计（零 symlink）→ 冒烟启动 `/api/version` → 打包 `@previously-lab/kernel`（版本号取 tag，不经 APP_VERSION——bump-version 是事后回同步的）→ 上传 tarball artifact → `npm publish --provenance`。
2. **再发 client**（本仓库）：
   - package.json 升 `version`、`previously.kernelVersion`、`dependencies["@previously-lab/kernel"]` 三处（check-release 会拦住 pin 不一致；preview 发布时 `version` 用 `X.Y.Z-preview.N`，后两处仍是稳定的 `X.Y.Z`）。
   - 推送 tag `vX.Y.Z`（或 `vX.Y.Z-preview.N`）。
   - `release.yml` 自动：一致性校验 → 确认 pinned 内核已在 npm（不在则报错提示先发内核）→ build + 全量测试 → pack → 冒烟（全局安装 tarball、CLI 应答、`kernel install` 走依赖路径、`kernel current`）→ 按版本号推导 dist-tag 后 `npm publish --provenance --tag <dist-tag>`。

## 临时措施清理（内核首发后做一次）

- ~~删除本仓库根目录的 `pnpm-workspace.yaml`~~ **已做（v0.9.2）**：内核上 npm 后本地 override 已移除，`test.yml`/`release.yml` 的 strip 步骤已删、`--frozen-lockfile` 已恢复。
- **但文件保留**：pnpm 11 默认启用 `minimumReleaseAge: 1440`（24 小时冷静期），而 client 发布时内核总是刚发布几分钟——`pnpm-workspace.yaml` 现在只携带 `minimumReleaseAgeExclude: ['@previously-lab/kernel']`（第一方包、自家 CI 带 provenance 发布，豁免是安全的），不要再删它。
- `pnpm install` 更新 `pnpm-lock.yaml` 并提交。

## 失败排查

- `release-kernel.yml` 出厂审计失败：standalone 产物残留 symlink —— 查 `scripts/pack-standalone.mjs` 日志。
- 冒烟失败：standalone server 起不来 —— 先在本地 `pnpm build:standalone` 后手工 boot 复现。
- client 发布卡在 "pinned kernel is not on npm"：顺序错了，先发内核。
- preview 版被装到 latest 用户：检查发布日志里的 dist-tag 推导输出；若推错用 `npm dist-tag add/rm` 修正，不要重发。
- npm provenance 报错：确认 `id-token: write` 权限在 workflow 里未被删。
