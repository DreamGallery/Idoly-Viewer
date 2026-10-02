# 音乐播放器

运行 `npm run dev` 后，页面底部显示迷你播放器，点击封面或展开按钮打开完整面板。歌曲名、演唱者取自 MasterDB `Music.json`，封面使用游戏的 `img_music_jacket_*`，音频使用 `sud_music_short_*`，因此播放的是游戏版歌曲。

需要 Python、`requirements-music.txt` 中的依赖，以及本地的 MasterDB 和 Octo 资源清单。安装依赖后，在被 Git 忽略的 `.env.development.local` 中按需配置：

```dotenv
IDOLY_MUSIC_PYTHON=/path/to/venv/bin/python
# 可选；留空时使用系统 ffmpeg 或 imageio-ffmpeg 自带的程序
IDOLY_MUSIC_FFMPEG=/path/to/ffmpeg
# 可选；默认读取项目旁的 HoshimiToolkit 与 Idoly-localify 文件夹
IDOLY_MUSIC_MANIFEST=/path/to/OctoManifest.json
IDOLY_MUSIC_MASTER=/path/to/Music.json
```

首次请求会生成曲库；歌曲和封面按需下载、校验、解包，并保存在 `.local/music/`。音频编码为 FLAC 8 级，复用缓存，接口支持范围请求。更新清单后可运行 `python -m idoly_story_index.music catalog` 刷新曲库。

支持搜索、切歌、拖动进度、音量、列表循环／单曲循环／随机播放。播放剧情语音会暂停音乐，静音动态卡面不会打断音乐。页面内切换路由或收起面板时继续播放；刷新页面不会自动播放。

## NAS 与 Worker

NAS 从固定版本的 MasterDB 读取 `Music.json`，将歌曲、封面加入网站资源计划，使用原有下载重试、FLAC 8 验证编码、缓存和 R2 批量上传流程。曲库保存为 `/data/music.json`，音频和封面通过现有媒体接口读取，并与剧情索引固定在同一发布版本。

部署网页后，旧资源版本没有曲库时暂不显示播放器。更新 NAS 镜像并完成一次资源发布后，刷新网页即可使用，无需新增环境变量。
