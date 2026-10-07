# 星见事务所 · IDOLY PRIDE 剧情索引

非官方剧情索引与翻译协作网站，基于 [Campus Viewer](https://github.com/DreamGallery/Campus-Viewer) 改造。支持剧情分组、卡牌筛选、文本更新、图片与动态卡面、逐句语音、游戏音乐播放器，以及 GitHub 翻译／校对协作。

## 部署结构

- **Cloudflare Worker**：网页、资源读取、GitHub OAuth 与协作接口。
- **R2**：索引、剧情文本、图片、语音、歌曲与封面、动态卡面及最近五个游戏增量包。
- **D1**：加密登录会话，不保存翻译稿件。
- **Docker（linux/amd64）**：更新资源、读取 MasterDB、生成索引和增量包、上传 R2。

MasterDB 使用 [ipr-master-diff](https://github.com/MalitsPlus/ipr-master-diff)。优先读取匹配提交的完整 Actions 附件；附件不可用时，读取同一提交下索引所需的数据表。

## 安装与配置

准备 Node.js 22.12+、Docker Compose、Cloudflare 账号及已有的 R2 桶。依次完成：

1. 安装网页依赖：`npm ci`。
2. 将 `wrangler.jsonc` 复制为 `wrangler.local.jsonc`，填写账号、桶名、D1 ID、站点地址。
3. 将 `.dev.vars.example` 复制为 `.dev.vars`，填写 GitHub OAuth 配置及随机会话密钥。
4. 将 `deploy/.env.r2.example` 复制为 `deploy/.env.r2.local`，填写更新器的 R2、GitHub 与 Octo 资源配置。
5. 按 [部署教程](docs/cloudflare-deployment.md) 初始化 Docker 更新器，并发布 Worker。网页可以先上线，更新器完成首次资源发布后会自动载入。

已有配置文件不要覆盖。实际配置均已加入 `.gitignore`；密钥只放本地配置或 Cloudflare Secrets，不使用 `VITE_` 前缀。

## Docker 启动

在项目根目录执行：

```sh
docker compose -f deploy/compose.r2.yaml build
docker compose -f deploy/compose.r2.yaml run --rm updater python -m idoly_story_index.runtime --once
docker compose -f deploy/compose.r2.yaml up -d
docker compose -f deploy/compose.r2.yaml logs -f --tail=100
```

也可以直接使用 [预编译镜像与 Docker Compose](deploy/docker/README.md)，无需自行编译。首次运行下载网站所需资源并建立增量基线，之后每次资源更新生成一个完整增量包，保留最近五包。没有历史清单时不能恢复过去的增量。

包中包含全部变化资源、解出的原始 PNG、适用图片的比例修正副本及删除列表。网站语音由更新器默认编码为 FLAC 8 级，首次启动也可选 MP3／AAC，后续复用对应编码缓存，详见 [语音说明](docs/voice-index.md)。上传按内容去重，日志显示进度；完整校验通过后才切换线上版本。

保留 `/runtime` 持久卷。只允许一个更新器向同一 R2 前缀发布。

## 本地开发

```sh
npm run dev:api:github
npm run dev -- --host 127.0.0.1 --port 5173
```

音乐播放器与本地曲库配置见 [音乐说明](docs/local-music.md)。本地数据准备见 [索引生成说明](docs/indexer.md)，语音解码见 [语音说明](docs/voice-index.md)。本地 GitHub 登录使用 `.env.oauth.local`，回调为 `http://127.0.0.1:5173/api/auth/callback`。`npm run dev:api` 可使用本地演示协作模式。现有本地资源路径和构建参数见 `python scripts/build-idoly-data.py --help` 与 `python -m idoly_story_index.build --help`。

```sh
npm run build
npm run test:api
npm run test:workbench
npm run test:cloudflare
```

## 翻译协作

稿件保存到配置的 GitHub 工作仓库；任务来自该仓库按协作格式创建的 Issue。CSV 保留 `id,name,text,trans` 四列，末尾依次为 `info` 与 `译者` 行。

- 完成翻译：署名为 `翻译：XXXX`。
- 完成校对：追加 `；校对：XXXX`。
- 重新校对替换旧校对署名；修改译者保留已有校对署名。

原文含字面量 `\n` 时，译文每行最多 21 字（标点计入，格式标签与注音内容不计入）。超限会提示位置并阻止 CSV／TXT 导出及正式提交；仍可载入修改和保存草稿。原文无 `\n` 时不限制单行字数，换行数量仍须与原文一致。

`_short.csv` 不进入索引。缺少明确 MasterDB 归属的文本进入“待补全资料”；可唯一归入已有活动或主线章节的补充文本保留在对应分组。

素材版权归原权利人所有。基础代码与许可见 [UPSTREAM.md](UPSTREAM.md)，字体许可见 `public/fonts/`。
