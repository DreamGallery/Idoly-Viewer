# Cloudflare Worker + R2 + Docker 部署

Worker 托管网页和协作接口，D1 保存登录会话，R2 保存原文、索引和游戏资源。Docker 更新器负责下载、解包、生成索引和上传；译文与草稿保存在 GitHub 工作仓库。

## 准备配置

需要 Node.js 22.12+、Docker Compose、Cloudflare 的 Worker／R2／D1 权限及 GitHub OAuth App。以下命令在仓库根目录执行，已有配置文件请保留：

```sh
npm ci
cp -n wrangler.jsonc wrangler.local.jsonc
npx wrangler login
npx wrangler d1 create YOUR_AUTH_DATABASE
```

在 `wrangler.local.jsonc` 中填写：

| 配置 | 内容 |
| --- | --- |
| `account_id` | R2 所在 Cloudflare 账号 |
| `r2_buckets[0].bucket_name` | 现有桶名，绑定名保留 `RESOURCES` |
| `d1_databases[0].database_name`、`database_id` | D1 名称及创建时返回的 ID，绑定名保留 `DB` |
| `vars.CAMPUS_PUBLIC_ORIGIN` | 网站地址，例如 `https://story.example.com` |
| `vars.IDOLY_R2_PREFIX` | 资源前缀，默认 `idoly-v1`，与 Docker 配置一致 |
| `vars.CAMPUS_WORK_OWNER`、`CAMPUS_WORK_REPO`、`CAMPUS_WORK_BRANCH` | 协作仓库及分支，分支使用 `collaboration` |
| `vars.IDOLY_R2_PUBLIC_BASE_URL` | 可选的增量包下载域名，不含路径；留空通过 Worker 下载 |

在 `routes` 中配置网站自定义域名，与 `CAMPUS_PUBLIC_ORIGIN` 和 OAuth 回调保持一致。保留 `workers_dev: false`、`preview_urls: false` 及两个 `ratelimits` 绑定；其 `namespace_id` 应与同一账号下其他应用区分。

## 登录与网页部署

GitHub OAuth App 的 Homepage 填网站地址，Callback 填 `<网站地址>/api/auth/callback`。`SESSION_SECRET` 使用至少 32 字符的随机值。

```sh
npx wrangler d1 migrations apply YOUR_AUTH_DATABASE --remote --config wrangler.local.jsonc
npx wrangler secret put GITHUB_CLIENT_ID --config wrangler.local.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.local.jsonc
npx wrangler secret put SESSION_SECRET --config wrangler.local.jsonc
npm run build:cloudflare
npx wrangler deploy --config wrangler.local.jsonc
```

`build:cloudflare` 只构建和预检查，`wrangler deploy` 才会上线。本地模拟可复制 `.dev.vars.example` 为 `.dev.vars` 并填写密钥；该文件不会自动同步为正式 Secret。

游客可阅读原文、本地编辑和导入导出。工作仓库中的任务、译文和草稿要求登录并具有仓库写权限。

## Docker 更新器

```sh
cp -n deploy/.env.r2.example deploy/.env.r2.local
chmod 600 deploy/.env.r2.local
```

在 `deploy/.env.r2.local` 中填写：

| 变量 | 内容 |
| --- | --- |
| `IDOLY_R2_ENDPOINT` | R2 控制台提供的 S3 API endpoint |
| `IDOLY_R2_BUCKET`、`IDOLY_R2_PREFIX` | 桶名和前缀，与 Worker 一致 |
| `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY` | 限定该桶的对象读写凭据，需能列举对象 |
| `IDOLY_R2_PUBLIC_BASE_URL` | 可选资源域名，例如 `https://assets.example.com`，不含路径；留空通过 Worker 读取 |
| `IDOLY_SOURCE_REPO/BRANCH`、`IDOLY_TRANSLATION_REPO/BRANCH` | 原文仓库和已发布译文仓库，分支通常为 `main` |
| `IDOLY_MASTER_REPO/REF` | MasterDB 仓库及分支／提交，默认 `MalitsPlus/ipr-master-diff` 的 `main` |
| `IDOLY_GITHUB_TOKEN` | 私有文本仓库需 Contents 读取权限；下载 MasterDB Actions 附件需 Actions 读取权限 |
| `IDOLY_OCTO_URL/APP_ID/VERSION/CLIENT_SECRET_KEY` | 游戏资源清单配置，具体变量名见模板 |
| `IDOLY_OCTO_AES_PASSPHRASE` 或 `IDOLY_OCTO_AES_KEY_HEX` | 二选一：原始文本密钥，或已派生的 32／48／64 位十六进制 AES 密钥 |

资源域名需绑定到存放公开内容的 R2 桶，并按 [CORS 示例](../deploy/r2-cors.example.json)填写网站地址。S3 密钥只供更新器使用，Worker 通过桶绑定读取资源。

从源码构建并启动：

```sh
docker compose -f deploy/compose.r2.yaml build updater
docker compose -f deploy/compose.r2.yaml up -d updater
docker compose -f deploy/compose.r2.yaml logs -f --tail=100 updater
```

也可使用 [预编译镜像](../deploy/docker/README.md)，架构为 `linux/amd64`。修改配置后重新创建容器，单独 `restart` 不会载入新的环境变量。

首次运行下载和处理资源，之后默认每六小时检查更新。`IDOLY_UPDATE_INTERVAL`、`IDOLY_DOWNLOAD_WORKERS`、`IDOLY_UPLOAD_WORKERS` 分别控制间隔、下载及上传并发。临时下载错误额外重试最多三次；整轮失败后最多等待十五分钟重试。下载／解包和 R2 上传分别输出进度。

语音默认 FLAC 8 级，首次启动可选 MP3／AAC；配置见 [语音说明](voice-index.md)。歌曲和封面自动加入资源更新，无需单独配置。

## 资源更新与数据保留

MasterDB 按 [ipr-master-diff 说明](https://github.com/MalitsPlus/ipr-master-diff#artifacts)读取同一提交的 Actions 附件；附件不可用时读取该提交所需的数据表。文本、MasterDB、游戏资源、更新器代码或配置变化会触发发布，无变化则跳过。

页头提供最近五份增量资源包。首次建立基线，之后包含上次成功基线以来全部新增或变化的游戏资源、删除列表、原始 PNG 和适用图片的比例修正副本。包内目录权限为 `755`，文件为 `644`。

媒体与文本按内容去重，批量检查 R2 对象清单。全部上传并校验成功后切换 `current.json`；失败时保留上一版本。

- 保留并备份 `/runtime` 持久卷，升级不执行 `down -v`。同一 R2 前缀只运行一个更新器。
- 清理 R2 时保留 `current.json` 指向的 `releases/<release>/` 及其引用的 `text/`、`media/` 对象。其他版本是否保留取决于回滚和已打开页面的需要；这些对象不会自动清理。
- 不给 `current.json` 设置永久缓存，也不要对整个 R2 前缀设置自动删除规则。
- 网站代码更新需部署 Worker；资源和索引由 Docker 更新器发布。
