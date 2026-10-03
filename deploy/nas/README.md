# NAS：从 Docker Hub 运行资源更新器

镜像：`dreamgallery/idoly-r2-updater:20261003-cf7`，架构 `linux/amd64`。

1. 将本目录的 `docker-compose.yaml` 放到 NAS 的专用目录。
2. 将已填写的 `.env.r2.local` 放到同一目录。配置模板见上一级的 [配置示例](../.env.r2.example)，填写说明见 [部署教程](../../docs/cloudflare-deployment.md)。
3. 在该目录执行：

```sh
chmod 600 .env.r2.local
docker compose pull updater
docker compose up -d updater
docker compose logs -f --tail=100 updater
```

Compose 已包含默认镜像版本。需要覆盖版本时，将 `.env.example` 复制为 `.env`，修改 `IDOLY_UPDATER_IMAGE`；它会优先于 Compose 中的默认值。修改 `.env.r2.local` 后，用 `docker compose up -d --force-recreate updater` 重新创建容器，使新环境变量生效。

首次下载并解包网站所需资源、生成索引、建立增量基线，然后上传 R2。发布完成后网页自动读取；默认每六小时检查更新。容器不需要开放入站端口。

下载／解包日志中的 `completed` 为本轮新处理任务，`cached` 为复用已处理结果，`downloaded` 为实际下载字节。之后的 R2 阶段独立统计上传进度。临时下载错误最多额外重试三次；整轮失败后最多等待十五分钟再试。

`runtime` 卷保存下载缓存、Git 仓库、发布快照及增量基线。升级和迁移时保留此卷，不要执行 `down -v`。同一 R2 前缀只运行一个更新器。私密配置不要上传到 GitHub 或 Docker Hub。

语音默认使用 FLAC 8 级，已有 FLAC 缓存直接复用。首次启用本版本时，也可在 `.env.r2.local` 设置 `IDOLY_VOICE_CODEC=mp3` 或 `aac`，以及 `IDOLY_VOICE_BITRATE=96`。选择保存在 runtime 卷中，后续启动沿用；歌曲仍使用 FLAC。详见 [语音说明](../../docs/voice-index.md)。

音乐曲库与游戏封面由更新器一并生成、缓存并上传 R2。首次升级会补充歌曲资源；等日志显示发布完成后刷新网页，即可看到音乐播放器。无需新增配置项。
