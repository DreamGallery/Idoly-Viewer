# Worker + R2 + Docker 部署

资源更新器通过 Docker Compose 运行，预编译镜像支持 `linux/amd64`。

## 配置文件

项目根目录执行以下复制操作；已有文件不要覆盖：

```sh
cp -n wrangler.jsonc wrangler.local.jsonc
cp -n .dev.vars.example .dev.vars
cp -n deploy/.env.r2.example deploy/.env.r2.local
chmod 600 .dev.vars deploy/.env.r2.local
```

| 位置 | 填写内容 |
| --- | --- |
| `wrangler.local.jsonc` | `account_id`、`r2_buckets[0].bucket_name`、`d1_databases[0].database_id`、`vars.CAMPUS_PUBLIC_ORIGIN` |
| `wrangler.local.jsonc` | `vars.IDOLY_R2_PREFIX` 与 Docker 更新器配置相同；协作仓库的 `CAMPUS_WORK_OWNER/REPO/BRANCH` |
| `.dev.vars` | `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`SESSION_SECRET`（至少 32 字符随机值） |
| `deploy/.env.r2.local` | `IDOLY_R2_ENDPOINT`、`IDOLY_R2_BUCKET`、`IDOLY_R2_PREFIX`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY` |
| `deploy/.env.r2.local` | `IDOLY_GITHUB_TOKEN`：原文／译文仓库 Contents 读取权限，MasterDB Actions 附件读取权限 |
| `deploy/.env.r2.local` | `IDOLY_SOURCE_REPO/BRANCH`、`IDOLY_TRANSLATION_REPO/BRANCH`：实际原文与译文仓库 |
| `deploy/.env.r2.local` | `IDOLY_MASTER_REPO/REF`：MasterDB 仓库和分支／提交 |
| `deploy/.env.r2.local` | `IDOLY_OCTO_URL/APP_ID/VERSION/CLIENT_SECRET_KEY` 与 `IDOLY_OCTO_AES_PASSPHRASE` 或 `IDOLY_OCTO_AES_KEY_HEX` 二选一 |

Octo 参数用于资源清单，不需要游戏账号登录。使用自己的现有资源工具配置；不要把 `config.ini`、设备数据或凭据加入镜像。`vendor/hoshimi/` 仅含解析器与协议定义。

AES 两项只填一项，另一项留空：原始文本密钥填 `IDOLY_OCTO_AES_PASSPHRASE`，更新器会计算 SHA-256；已经派生好的 AES 密钥填 `IDOLY_OCTO_AES_KEY_HEX`，需为 32／48／64 位十六进制字符（`0-9`、`a-f`，不带 `0x`）。不要直接将原始字符串填入 `KEY_HEX`，也不要只将原始字符串转为十六进制来代替派生。

若日志出现 `non-hexadecimal number found in fromhex()`，检查 `IDOLY_OCTO_AES_KEY_HEX` 是否误填原始字符串或占位内容。修改 Docker 配置文件 `.env.r2.local` 后执行 `docker compose up -d --force-recreate updater`，随后用 `docker compose logs -f --tail=100 updater` 查看结果；单独 `restart` 不会重新载入环境变量。不要删除 runtime 卷。

R2 S3 凭据仅配置在 Docker 更新器中，权限限制到指定桶的对象读写。Worker 通过 `RESOURCES` 绑定读取 R2，不需要 S3 密钥。无需公开 R2 桶或配置资源域名；资源默认经同源 Worker 提供。

## 构建和启动 Docker 更新器

使用源码构建时，在项目根目录执行：

```sh
docker compose -f deploy/compose.r2.yaml build updater
docker compose -f deploy/compose.r2.yaml run --rm updater python -m idoly_story_index.runtime --once
docker compose -f deploy/compose.r2.yaml up -d updater
docker compose -f deploy/compose.r2.yaml logs -f --tail=100 updater
```

Compose 已指定 `linux/amd64`。如需构建并推送镜像，供其他 Docker 环境拉取：

```sh
docker buildx build --platform linux/amd64 -f docker/Dockerfile.updater \
  -t YOUR_REGISTRY/YOUR_IMAGE:YOUR_VERSION --push .
```

使用预编译镜像时，在部署目录放置三个文件：

- `deploy/nas/docker-compose.yaml` → `docker-compose.yaml`
- `deploy/nas/.env.example` → `.env`，将 `IDOLY_UPDATER_IMAGE` 改成自己的标签或 digest
- 已填配置 → `.env.r2.local`，权限 `600`

然后执行 `docker compose pull`、`docker compose up -d`。容器无需开放端口、特权模式或 Docker socket。运行目录使用持久卷；迁移时保留该卷并先停止旧更新器。

默认每 21600 秒检查一次；失败最多等待 900 秒重试。通过 `IDOLY_UPDATE_INTERVAL`、`IDOLY_DOWNLOAD_WORKERS`、`IDOLY_UPLOAD_WORKERS` 调整间隔和并行数。首次要下载、解包整个网站引用的媒体，预留足够磁盘；语音默认使用 FLAC 8 级无损压缩，也可在首次启动前通过 `IDOLY_VOICE_CODEC` 和 `IDOLY_VOICE_BITRATE` 选择 MP3／AAC 及码率，选择保存在持久卷中，原始图片、游戏包及增量包仍需额外磁盘空间。后续运行复用已有缓存，详见 [语音说明](voice-index.md)。

游戏媒体、增量资源、资源清单及官网立绘下载遇到网络超时／断流、HTTP 408／429／500／502／503／504 时，单次下载最多额外重试 3 次（共 4 次尝试），间隔 2／4／8 秒；数字形式的 `Retry-After` 可延长等待，最多 60 秒。游戏资源大小或校验和不符也会重新下载，临时文件在每次尝试后清理，校验成功才写入缓存。401／403／404、证书错误、磁盘错误和解包／名称错误不重试。耗尽后本轮失败，仍按上述整轮间隔重试。

`Website media download/extract` 和 `Game increment download/extract` 是更新器的下载／解包阶段，`completed` 为本轮新处理任务数，`cached` 为复用已处理结果数，`downloaded` 为本轮实际收到的下载字节（包括失败后重传，不包含缓存和解包后体积）。一个任务可能是包含多句语音的资源包。全部准备完成后才进入单独的 `R2` 上传阶段，其 `uploaded`／`skipped` 表示上传／跳过对象数。

`--prepare-only` 可在**独立测试 runtime** 生成快照而不上传。它不推进正式基线，也不访问已有 R2 发布；不要将这个测试目录直接当作已有站点的生产卷。

## 数据更新和增量包

1. 同步原文与译文 Git 仓库，保留提交历史以生成文本更新页面。
2. 固定 MasterDB 提交。依照 [仓库说明](https://github.com/MalitsPlus/ipr-master-diff#artifacts)，优先找同提交的 `databases` Actions 附件。附件过期、不存在或未配置下载凭据时，从该提交读取所需表；压缩 JSON 可解包，不读取无关的大型 `Reward` 表。失败不混入旧表。
3. 更新 Octo 完整资源清单，生成 MasterDB 分类索引，并在容器中解包网站图片、逐句语音及动态卡面。
4. 首次记录完整基线。之后对全部 AssetBundle／Resource 条目按内容比较，下载所有新增／变化项，记录删除项；不局限于网站引用的素材。
5. 包内 `assetbundle/` 为解密后的资源，`resource/` 为原始资源文件，`image/Texture2D/` 为 PNG，`stretch/` 为按 IDOLY 规则修正为 2560×1440 的卡面／适用主视觉副本。原图同时保留。`increment.json` 记录范围。
6. 归档文件 `644`、目录 `755`，清除所有者和 ACL。私密环境配置文件仍保持 `600`，两者用途不同。
7. 上传资源、文本、最近五包和分片映射，校验后以 ETag 条件切换 `current.json`。失败时旧发布继续服务。

只保留最近五个增量包，不会伪造首次运行前的历史更新。跨过多次游戏更新才运行时，生成的是上次成功基线到当前版本的完整差异包。旧媒体与索引暂保留供已打开页面及回滚使用，未做自动垃圾回收。

Git 原文／译文、MasterDB、资源清单、处理代码或固定素材有变化时都会触发新发布；完全未变则跳过。媒体按 SHA-256 去重，分页检查已有对象，上传每十秒输出处理数量、上传／跳过／失败、字节量与耗时。不输出凭据或签名链接。

R2 布局及映射格式见 [RELEASE-PROTOCOL.md](../cloudflare/RELEASE-PROTOCOL.md)。已打开网页固定在同一发布版本，避免播放中途混入新版文本和语音。

## Cloudflare 初始化与发布

安装依赖并创建独立 D1 数据库：

```sh
npm ci
npx wrangler login
npx wrangler d1 create YOUR_AUTH_DATABASE
```

将返回 ID、实际数据库名和 R2 桶名填入 `wrangler.local.jsonc`。站点地址可以先用 Worker 的 `workers.dev` 域名。GitHub OAuth App 的 Homepage URL 填站点 origin，Callback URL 填 `https://YOUR_SITE/api/auth/callback`。

```sh
npx wrangler d1 migrations apply YOUR_AUTH_DATABASE --remote --config wrangler.local.jsonc
npx wrangler secret put GITHUB_CLIENT_ID --config wrangler.local.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.local.jsonc
npx wrangler secret put SESSION_SECRET --config wrangler.local.jsonc
npm run build:cloudflare
npx wrangler deploy --config wrangler.local.jsonc
```

`.dev.vars` 仅用于本地模拟，不会自动上传成正式 Secret。`build:cloudflare` 只构建并 dry-run，最后一条才真正发布。

网页可以先上线；首次 R2 发布前会显示资源准备提示并自动重试。更新器完成首次发布后再核对内容。检查目录、图片、逐句语音、动态卡面、GitHub 登录和任务读取。没有规范任务 Issue 时协作页为空是正常情况。翻译／校对正式稿仍写 GitHub；更新器下次同步后更新公开索引。

## 维护

- 不要删除 runtime 卷。远端已有发布而本地基线缺失时，更新器会拒绝继续；恢复卷备份，或使用新的专用前缀重新初始化。
- 同一前缀只运行一个更新器；条件冲突不能强行覆盖。
- 网站代码更新需重新发布 Worker；资源内容更新由 Docker 更新器自动完成。
- 不给 `current.json` 设置永久缓存，也不要对整个 R2 前缀设置短期自动删除。
- 更新器升级保留持久卷；公网地址变化时同步修改 Worker origin 与 OAuth callback。

参考：[Campus Viewer](https://github.com/DreamGallery/Campus-Viewer)、[GitHub Artifacts API](https://docs.github.com/en/rest/actions/artifacts)、[R2 Worker 绑定](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/)。
