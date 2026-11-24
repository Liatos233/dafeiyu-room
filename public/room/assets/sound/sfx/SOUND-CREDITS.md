# 音效素材来源与许可证

这个目录（`public/room/assets/sound/sfx/`）下的音频是房间里的**动作音效**，
和 `assets/sound/ambience/`（天气环境音）分开：环境音是背景床，动作音效是
「她做了什么」的即时反馈。

## 许可证：全部 CC0 1.0（公有领域）

CC0 不要求署名，但**必须留存来源记录** —— 这是本项目以前的欠账：
`ambience/` 里那 6 个 ogg 现在没有任何来源信息（ffmpeg 转码时把 tags 剥了，
仓库里也没写），已经无从追溯。新素材从一开始就记在这里，不要再重演。

| 文件 | 来源 | 作者 | 许可证 |
|---|---|---|---|
| `step-1…6.ogg` | [Footsteps](https://opengameart.org/content/footsteps-0) | 匿名（OpenGameArt） | CC0 |
| `swim-1…4.ogg` | [40 CC0 water / splash / slime SFX](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | rubberduck | CC0 |
| `splash-enter.ogg` | 同上（`splash_01.ogg`） | rubberduck | CC0 |

- **脚步**：作者自述在地铁里实录、Audacity 去噪归一。原始 7 个片段，取了
  `01`–`06` 六个当变体轮换（`07` 与已选的重复度高，没用）。
- **水声**：rubberduck 的 40 个素材包，取 4 个短促溅水当划水、1 个较长的当入水。
  同一包里 `slime_*`（16 个）和 `loop_water_*`（9 个）还没用上，将来要加
  「涉水走」「游泳循环」可以直接取。

## 规整方式（可复现）

原始素材电平参差 —— 六个脚步的 RMS 差 **8.4 dB**，直接用就是一步重一步轻。
构建脚本 `scripts/build-sfx.mjs` 做三件事：

1. 裁到动作长度（脚步 0.40s、划水 0.45s、入水 0.90s）；
2. **按 RMS 归一**到 -20 dBFS（不是按峰值 —— 峰值归一只能保证最响的一下一样响，
   实测残差仍有 8.4 dB）；
3. 迭代校正：加限制器后实测输出响度，差多少补多少，两轮内收敛。
   直接算一步会失真 —— 水声原始峰值已接近 0 dBFS，按 RMS 加 +9.6dB 会被限制器
   硬压回去，实际反而低 4dB。

最终 RMS 极差 **1.9 dB**（-21.7 … -19.8），峰值 ≤ 0 dBFS，单声道 44.1kHz ogg。

## 加新音效

音效是**数据驱动**的：在 `scripts/sfx-manifest.json` 里加一条，跑
`node scripts/build-sfx.mjs`，然后把文件路径写进 `public/room/sfx.js` 的事件表。
只有需要规整电平的采样才走构建脚本；纯合成音（UI 点击之类）不需要任何文件。