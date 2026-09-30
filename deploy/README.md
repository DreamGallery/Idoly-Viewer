# 星见事务所部署

当前使用 **Cloudflare Worker + R2 + x86 NAS Docker**：Worker 提供网页与协作接口，D1 保存加密登录会话，NAS 负责游戏资源下载、解包、剧情索引生成及 R2 上传。

- 完整配置步骤：[部署教程](../docs/cloudflare-deployment.md)。
- 使用预编译镜像：[NAS 启动说明](nas/README.md)。
- NAS 配置模板：[.env.r2.example](.env.r2.example)。

镜像包含更新器代码、依赖，以及 IDOLY PRIDE 的固定界面素材（标志、背景、组合和筛选图标等）。私密配置、下载缓存、生成的索引和语音不打入镜像；首次运行时在 NAS 获取并处理所需资源。

资源准备完成后才上传 R2，校验通过后切换线上索引。下载和上传分别显示进度；失败保留上一版，已完成的下载及解包缓存可以复用。具体重试策略、增量包规则和配置项见部署教程。

保留 `/runtime` 持久卷，普通升级不要执行 `docker compose down -v`。同一 R2 前缀只运行一个更新器。
