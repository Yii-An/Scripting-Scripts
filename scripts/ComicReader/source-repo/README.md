# ComicReader 书源仓库

漫画书源的**权威发布地**。App 不内置任何源——全部由用户在「书源 → 导入」粘 URL 远程订阅。
设计权威见 [`../docs/remote-sources-design.md`](../docs/remote-sources-design.md)。

## 目录结构

```
source-repo/
├── sources/<id>.json     每源一份原文，字节级不改写（导入单位就是这一份）
├── sources-index.json    发布侧账本（id/name/version/sha256/url），由脚本生成，勿手改
├── index.html            查看页：一览所有源 + 复制导入地址（读 sources-index.json 渲染）
├── _headers              Cloudflare Pages 响应头（Content-Type + 缓存）
└── README.md             本文件
```

- `sources-index.json` 的 `url` 是**相对路径**（`sources/<id>.json`），对 GitHub raw / jsDelivr / Cloudflare 同时成立。
- **App 不消费 index**，它只是发布侧的「内容变了必须 bump version」比对基准（防忘记升版本号）。

## 新增 / 更新一个源

1. 编辑或新增 `sources/<id>.json`（文件名必须等于源内 `id`）。
2. **改了已发布源的内容，必须把源内 `version` +1**（id 永不变——换域名只往 `host` 数组加镜像）。
3. 重新生成账本（同时跑结构校验 + version-bump 守门）：
   ```bash
   pnpm build-source-index
   ```
   内容变了却没 bump version 会**生成失败**并报错，挡住忘升号。
4. `git commit` 源文件 + `sources-index.json`，push。

本地真机调试用局域网静态服务器（URL 布局与线上同构）：
```bash
pnpm serve-sources        # 打印 http://<Mac局域网IP>:8787/sources/<id>.json
```

## 发布（托管）

源是**几 KB 的 JSON、只在导入/检查更新时偶发拉取**，漫画图片是 App 直连站点图床、不经此仓库。
所以**性能几乎不是考量**，重点是：不被审查删档（源含 NSFW 配置）、国内可达、缓存可控。

### 推荐：Cloudflare Pages 直接上传（不连 GitHub）

本地一条命令把 `source-repo/` 直传到 Pages，不依赖任何 Git 仓库，且复用根目录的 `_headers`（R2 读不了它）。

一次性准备：
```bash
npx wrangler login                                                  # 浏览器授权一次
npx wrangler pages project create comicreader-sources --production-branch main   # 建项目（仅首次）
```
之后每次发布：
```bash
pnpm publish-sources      # = build-source-index（校验 + 版本守门）→ wrangler pages deploy
```
导入地址：`https://comicreader-sources.pages.dev/sources/<id>.json`（可在 Pages → Custom domains 绑自定义域名）。
权威源 = 你本地的 `source-repo/`（在不在 git 都行）；发布 = 跑一次 `pnpm publish-sources`。

### 备选 A：连 GitHub 自动部署

不想每次手动跑命令，可让 Pages 连 `Yii-An/Scripting-Scripts` 自动部署：构建命令留空，**Build output directory = `scripts/ComicReader/source-repo`**，`git push` 即重新部署。

### 备选 B：jsDelivr（零基建，但需公开仓库）

```
https://cdn.jsdelivr.net/gh/Yii-An/Scripting-Scripts@main/scripts/ComicReader/source-repo/sources/<id>.json
```
jsDelivr 对 `@main` 缓存激进，推新版后用 `https://purge.jsdelivr.net/gh/...` 刷新，或把 `@main` 换成 `@<commit-sha>` / tag 固定。

### 备选 C：Cloudflare R2

`wrangler r2 object put` 或 rclone 同步 `sources/` 进公开桶 + 自定义域名；R2 不读 `_headers`，缓存头改在域名的 Cache Rules 里配（同样 `max-age=300`）。

### 避免

- **`raw.githubusercontent.com` 直接当导入 URL**——国内常被墙/超慢、约 5 分钟缓存、有限流。可作为最后兜底，不作首选。
- **Gitee / 阿里云 OSS / 腾讯 COS** 等国内托管——有内容审核，NSFW 配置迟早被封桶/删库。

## 查看页

部署后访问站点根 `<base>/`（如 `https://comicreader-sources.pages.dev/`）即一览所有源：名称 / id / 类型 / 版本 / 分级 / 镜像域名 + 一键复制导入地址。纯静态，客户端读 `sources-index.json` 渲染，无构建步骤。本地预览：`pnpm serve-sources` 后开 `http://<IP>:8787/`。

## App 导入

「书源 → 导入」粘 `<base>/sources/<id>.json`。导入后 meta 记 `originUrl`；「检查更新」按它重拉、比 `version` 字段，host 有变会在升级确认框里 diff 出来。
