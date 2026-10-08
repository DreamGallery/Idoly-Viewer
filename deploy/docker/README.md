# 使用 Docker 运行资源更新器

镜像：`dreamgallery/idoly-r2-updater:20261008-cf10`，架构 `linux/amd64`。

1. 将本目录的 `docker-compose.yaml` 放到部署目录。
2. 将 [配置模板](../.env.r2.example)复制为同目录下的 `.env.r2.local`，按 [部署教程](../../docs/cloudflare-deployment.md)填写。
3. 在该目录启动：

```sh
chmod 600 .env.r2.local
docker compose pull updater
docker compose up -d updater
docker compose logs -f --tail=100 updater
```

需要覆盖默认镜像版本时，将 `.env.example` 复制为 `.env`，修改 `IDOLY_UPDATER_IMAGE`。修改 `.env.r2.local` 后执行 `docker compose up -d --force-recreate updater`，使配置生效。

首次运行下载资源、生成索引并上传 R2，之后默认每六小时检查更新。容器无需开放端口。语音编码需在首次启动前选择，见 [语音说明](../../docs/voice-index.md)。

`runtime` 卷保存资源缓存、Git 仓库和发布基线。升级与迁移时保留此卷，不执行 `down -v`；同一 R2 前缀只运行一个更新器。
