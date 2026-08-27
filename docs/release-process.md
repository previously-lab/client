# 发布流程（GitHub 流水线）

两个 npm 包、两条 tag 流水线，**严格按顺序**：

```
agent 仓库 tag vX.Y.Z  →  release-kernel.yml  →  npm: previously-kernel@X.Y.Z
client 仓库 tag vX.Y.Z →  release.yml         →  npm: previously-client@X.Y.Z
```

版本策略（设计 §10.2）：client 与内核精确 1:1 绑定——`package.json` 的
`previously.kernelVersion` 与 `dependencies["previously-kernel"]` 必须相等，
`scripts/check-release.mjs` 在发布前强制校验。

## 一次性准备（仓库设置）

- agent 仓库：配置 secret `NPM_TOKEN`（npm automation token，对 `previously-kernel` 有发布权）。
- client 仓库：配置 secret `NPM_TOKEN`（对 `previously-client` 有发布权）。
- 首发 `previously-kernel` 前确认 npm 包名可用。

## 每次发布

1. **先发内核**（agent 仓库）：
   - 推送 tag `vX.Y.Z`（或发布同名 GitHub Release）。
   - `release-kernel.yml` 自动：构建 standalone → 出厂审计（零 symlink）→ 冒烟启动 `/api/version` → 打包 `previously-kernel`（版本号取 tag，不经 APP_VERSION——bump-version 是事后回同步的）→ 上传 tarball artifact → `npm publish --provenance`。
2. **再发 client**（本仓库）：
   - package.json 升 `version`、`previously.kernelVersion`、`dependencies["previously-kernel"]` 三处到 X.Y.Z（check-release 会拦住不一致）。
   - 推送 tag `vX.Y.Z`。
   - `release.yml` 自动：一致性校验 → 确认 pinned 内核已在 npm（不在则报错提示先发内核）→ build + 全量测试 → pack → 冒烟（全局安装 tarball、CLI 应答、`kernel install` 走依赖路径、`kernel current`）→ `npm publish --provenance`。

## 临时措施清理（内核首发后做一次）

- 删除本仓库根目录的 `pnpm-workspace.yaml`（它把 `previously-kernel` 解析到本地 `../Aftrbrez/dist-kernel`，仅内核未发布期间有效）。
- `pnpm install` 更新 `pnpm-lock.yaml` 并提交。
- `.github/workflows/test.yml` 恢复 `pnpm install --frozen-lockfile`，删掉 "Strip temporary local-kernel override" 步骤；`release.yml` 同样删掉该步骤并恢复 frozen-lockfile。

## 失败排查

- `release-kernel.yml` 出厂审计失败：standalone 产物残留 symlink —— 查 `scripts/pack-standalone.mjs` 日志。
- 冒烟失败：standalone server 起不来 —— 先在本地 `pnpm build:standalone` 后手工 boot 复现。
- client 发布卡在 "pinned kernel is not on npm"：顺序错了，先发内核。
- npm provenance 报错：确认 `id-token: write` 权限在 workflow 里未被删。
