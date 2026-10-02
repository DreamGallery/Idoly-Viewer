# 剧情语音

本项目使用 IDOLY PRIDE 的 Unity AssetBundle 语音资源。NAS 完成下载、解密、读取包内的 `CAB-…` 文件与 `AudioClip`，再通过 UnityPy 的音频解码器取得 PCM WAV，使用 `flac -8 --verify` 编为无损 FLAC。编码器会重新解码核对音频采样，成功后才写入缓存。当前流程不使用 ACB/AWB 或 vgmstream。

## 匹配与缓存

索引器从原始 ADV 脚本提取语音名、说话人与时间信息，结合 Octo 清单关联台词和资源包。一个包可能包含多句语音，因此更新器按资源包安排任务，统一提取所需 AudioClip。

优先精确匹配 AudioClip 名称；找不到时允许资源名带 `.wav` 扩展名。不会按顺序或相似名称猜测其他语音。出现歧义、缺少引用语音或解码失败时停止本轮发布，保留上一版。

下载文件先检查大小和 MD5，成功后写入缓存。临时网络错误最多额外重试三次；详情见 [部署教程](cloudflare-deployment.md)。缓存按资源内容校验值组织，后续运行复用下载及解码结果。

## 播放

准备完成的 FLAC 上传到 R2，由同源 Worker `/api/media/voice/<name>.flac` 提供，支持范围请求。线上 Worker 不执行解包或音频转换。

本地开发模式可以按需下载与解码，首次播放会更慢。可通过 `IDOLY_PYTHON` 指定已安装依赖的 Python 可执行文件；默认使用 `python3`，系统也需安装 `flac` 命令。本地缓存位于 `.local/media/`，不进入 Git 或镜像。
