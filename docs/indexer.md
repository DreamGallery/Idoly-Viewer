# 剧情索引生成

当前索引器位于 `idoly_story_index/`，只处理 IDOLY PRIDE。NAS 部署由 `python -m idoly_story_index.runtime` 自动同步数据、构建索引、处理媒体并发布 R2；安装步骤见 [部署教程](cloudflare-deployment.md)。

## 输入

- MasterDB：`MalitsPlus/ipr-master-diff` 中同一提交的完整 Actions 附件，或该提交下索引需要的数据表。
- 原文：配置的原文仓库，包含 `CSV/` 与 `Resource/`。
- 译文：工作仓库中的 `story/ai/`、`story/human/`、`story/reviewed/`。
- 游戏资源：Octo 资源清单、资源名及内容校验值。

主线按章节、组合按组合、卡牌按卡牌、活动按活动分组；羁绊和生日按角色分组。分类与标题优先使用 MasterDB，脚本补充信息必须能唯一对应到已知归属。`_short.csv` 不进入索引，明确重复脚本排除；无明确归属的文本放入“待补全资料”。HomeTalk 和 Message 目前仅保留导航入口。

## 本地手动构建

本地构建需要 Python 3.12+ 及 `requirements-r2.txt` 中的依赖。以下路径均替换为自己的数据目录，工具不会替你获取这些输入：

```sh
python scripts/build-idoly-data.py \
  --master /path/to/master-tables \
  --toolkit /path/to/HoshimiToolkit \
  --source /path/to/source-repository \
  --translations /path/to/translation-repository \
  --output public/data

python -m idoly_story_index.build \
  --master /path/to/master-tables \
  --toolkit /path/to/HoshimiToolkit \
  --source /path/to/source-repository \
  --translations /path/to/translation-repository \
  --output public/data
```

工具目录需要提供 `src/adv_csv.py` 和 `cache/OctoManifest.json`；NAS 会自动准备这些文件。手动构建不会上传资源。生成的数据、报告和游戏素材不提交 Git。

输出包括剧情目录、分组目录、逐章文本与媒体引用。语音处理见 [语音说明](voice-index.md)，线上发布格式见 [R2 协议](../cloudflare/RELEASE-PROTOCOL.md)。
