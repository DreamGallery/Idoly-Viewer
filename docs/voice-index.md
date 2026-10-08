# 剧情语音

Docker 更新器从游戏 AssetBundle 中提取 AudioClip，完成编码和校验后上传 R2。网页按台词播放已处理的音频，Worker 不执行解包或转码。

## 编码配置

首次启动前，在 `.env.r2.local` 中设置。例如使用 MP3 96 kbps：

```dotenv
IDOLY_VOICE_CODEC=mp3
IDOLY_VOICE_BITRATE=96
```

| 编码值 | 格式 | 码率 |
| --- | --- | --- |
| `flac` | FLAC 8 级，无损，默认 | 忽略码率设置 |
| `mp3` | MP3，有损 | 48、64、80、96、128、192 kbps |
| `aac` | AAC-LC，M4A 容器，有损 | 48、64、80、96、128、192 kbps |

MP3／AAC 默认 96 kbps。配置只影响剧情对话，歌曲使用 FLAC。

选择保存在 `/runtime/voice-encoding.json`。后续启动沿用保存值；显式配置与保存值冲突时停止更新。保留 runtime 卷，它还保存资源缓存和发布基线。

## 处理与缓存

语音名和时间信息取自原始 ADV 脚本，按包内 AudioClip 名称匹配，不按文件顺序猜测。一个资源包可能包含多句语音，更新器按包下载并提取。

下载校验大小和 MD5，编码后校验格式及完整性，成功才写入缓存。缺少引用语音、匹配歧义或解码失败时停止发布，保留上一版本。缓存按资源内容及编码配置复用。

## 本地开发

安装 `requirements-r2.txt` 中的依赖和 `flac` 命令。可通过 `IDOLY_PYTHON` 指定 Python 3.12+ 可执行文件，默认使用 `python3`。

本地默认 FLAC，首次播放按需下载和解码，可能需要等待。缓存位于 `.local/media/`，不进入 Git 或镜像。Docker 配置见 [部署教程](cloudflare-deployment.md)。
