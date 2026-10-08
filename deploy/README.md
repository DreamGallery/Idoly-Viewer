# 部署

- [Worker、R2 与 Docker 配置](../docs/cloudflare-deployment.md)
- [预编译镜像启动说明](docker/README.md)
- [更新器配置模板](.env.r2.example)

镜像包含更新器、依赖和固定界面素材。私密配置、下载缓存、生成的索引及游戏媒体由外部配置或持久卷提供，不打入镜像。
