# 音乐播放器

页面底部的播放器支持搜索、切歌、进度和音量调整，以及列表循环、单曲循环和随机播放。播放剧情语音会暂停音乐，静音动态卡面不会打断音乐。

歌曲名与演唱者来自 MasterDB，封面和音频使用游戏资源，播放的是游戏版歌曲。Docker 更新器自动生成曲库并上传歌曲及封面，无需单独配置。

## 本地开发

安装 Python 和 `requirements-music.txt` 中的依赖，并准备 MasterDB 与 Octo 资源清单。在被 Git 忽略的 `.env.development.local` 中按需配置：

```dotenv
IDOLY_MUSIC_PYTHON=/path/to/venv/bin/python
# 可选；默认使用系统 ffmpeg 或 imageio-ffmpeg 自带的程序
IDOLY_MUSIC_FFMPEG=/path/to/ffmpeg
# 可选；默认读取项目旁的 HoshimiToolkit 与 Idoly-localify 文件夹
IDOLY_MUSIC_MANIFEST=/path/to/OctoManifest.json
IDOLY_MUSIC_MASTER=/path/to/Music.json
```

运行 `npm run dev` 后，首次请求生成曲库，歌曲与封面按需下载并缓存到 `.local/music/`，音频使用 FLAC 8 级。更新资源清单后可运行 `python -m idoly_story_index.music catalog` 刷新曲库。
