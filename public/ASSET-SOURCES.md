# IDOLY PRIDE 界面素材来源

游戏素材与商标权利归 Project IDOLY PRIDE 及相关权利人所有。代码来源说明不改变素材的权利归属。

| 素材 | 来源与处理 |
| --- | --- |
| 官网字标与标签栏图标 | IDOLY PRIDE 官网；favicon 来源 `https://idolypride.jp/shared/img/common/favicon.ico`，字标路径位于 `src/App.tsx` |
| 动态背景 | 游戏 APK 的 `Texture2D ip_bg_black`，保存为 `images/background/ip-pattern.png`，由 CSS 控制色彩与移动 |
| 花色、类型、SP、觉醒筛选图标 | 游戏 APK 对应 Sprite，保存于 `images/card-filters/`；提取工具为 `scripts/extract-card-filter-icons.py` |
| 角色 Q 版头像 | Octo 的 `img_chr_icon_<Character.assetId>`，保留透明图形与完整显示区域 |
| 组合图标 | 优先彩色 `img_group_icon_*`；其余采用 `img_group_logo_<CharacterGroup.assetId>` 配合 MasterDB 中的组合颜色 |
| 主线与组合封面 | MasterDB 关联的 `img_story_parttop_*`／`img_story_partthumb_*`，分别按游戏界面的 4:3／1:1 显示 |
| 活动封面 | 优先 `img_story_event_banner_<EventStory.assetId>`，按 3:1 显示；其他场景保留原图比例 |
| 静态与动态卡面 | `img_card_full_*_<Card.assetId>` 与 `mov_card_full_*`，静态卡面按游戏 16:9 比例还原；觉醒关系使用 CardEvolution |
| 羁绊／生日立绘 | 官网角色页面的 `main_b` 常服／制服与 `main_a` 演出服；原始 URL 和 SHA-256 见 `deploy/nas/character-portraits.json` |
| 场景与语音 | 由原始 ADV、MasterDB 和 Octo 清单建立引用，在 NAS 处理后上传 R2 |

仓库只保留固定界面图标与背景。角色、封面、语音、动态卡面及生成索引由更新器获取；资源名映射见 `deploy/nas/image-assets.json`。字体许可见 `public/fonts/`。
