# npm 发布手册（dsh-cloud-workspaces）

> 2026-09-18 状态：`0.2.1` 已在 npm；**`0.2.2` 与 `0.3.0` 待发布**（本地 `npm pack --dry-run` 已验证：78 文件 / 290 kB / 构建绿）。
> 阻塞点只有一个：npm 令牌过期（`npm whoami` → ENEEDAUTH）。以下三步跑完即发布成功。

## 1. 生成令牌（网页操作，约 1 分钟）

<https://www.npmjs.com/settings/harryopo/tokens> → **Generate New Token** → 选 **Granular Access Token**：

- Packages and scopes：只勾 `dsh-cloud-workspaces`（read & publish）
- 其余默认，有效期按需（建议 30 天）

## 2. 发布（在本仓库根目录）

```sh
# 写入临时凭据（⚠️ 不要把 .npmrc 提交进 git）
echo "//registry.npmjs.org/:_authToken=<你的令牌>" > .npmrc

pnpm build          # 确保 lib/ 是最新产物（发布前置）
pnpm publish --access public --no-git-checks

rm .npmrc           # 发布后立即删除本地凭据
```

验证：`npm view dsh-cloud-workspaces version` 应输出 `0.3.0`。

## 3. 发布后

- 官方 Discussions #5229 追一行「npm 0.3.0 已发布」；
- README 顶部的 npm 徽章会自动指向新版本（shields 有缓存，稍等即可）。

## 常见坑

- `ENEEDAUTH`：`.npmrc` 没写对或令牌过期 —— 令牌内容不要带引号、路径键必须是 `//registry.npmjs.org/:_authToken=`。
- `E403 Two-factor authentication...`：Granular Token 已豁免；若用旧 Classic Token 需在发布页选 "publish only from trusted devices"。
- pnpm 会跑 `prepack`？本包没有 prepack 钩子，`lib/` 由 `pnpm build` 手工保证——**发布前务必先 build**。
