# 来源与许可

- 基础网页、翻译工作台和 Worker/R2 架构参考 [DreamGallery/Campus-Viewer](https://github.com/DreamGallery/Campus-Viewer)。本项目已适配 IDOLY PRIDE 的 MasterDB、CSV/TXT、Unity 资源和媒体发布流程。
- 翻译协作流程源自 [chihya72/gakumas-viewer](https://github.com/chihya72/gakumas-viewer)。保留原作者的 [MIT 许可](src/workbench/upstream/LICENSE)；该许可不代表所有游戏素材均采用 MIT 许可。
- `vendor/hoshimi/src/adv_csv.py` 与 `vendor/hoshimi/proto/octodb_pb2.py` 来自 HoshimiToolkit 的脚本解析器和协议定义。此目录不包含工具配置、账号凭据或缓存。
- MasterDB 数据源为 [MalitsPlus/ipr-master-diff](https://github.com/MalitsPlus/ipr-master-diff)，使用方式见其仓库说明与本项目部署文档。
- 游戏图像、语音、商标与其他素材归各权利人所有，来源见 [素材说明](public/ASSET-SOURCES.md)。IBM Plex 字体许可见 `public/fonts/`。

## 保留的兼容命名

部分协作配置使用 `CAMPUS_*` 环境变量名，主题使用 `campus-theme-v1` 浏览器存储键。这些名称仍参与当前运行，用于保持已有配置和主题偏好兼容，不代表调用旧游戏的数据源。以配置模板和当前部署教程为准，无需自行重命名。

旧游戏专用索引器、历史部署方案、未使用页面组件及阶段性评审记录不包含在此仓库中。
