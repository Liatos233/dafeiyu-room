# 交接文档（总）：大肥鱼 · 小蓝鱼 3D 房间系统

> 更新：**2026-11-18**　本地 HEAD：见 `git log`　云端部署：`1f0f1ee`（2026-11-17 09:14）
> 面向接手的新会话/新模型。本文是系统总览；分模块深潜见文末索引。

- 本地仓库：`C:\Users\liato\dafeiyu-room\app`（事实源）
- 线上房间：`http://101.245.76.51:3100/room/`
- 文档索引：
  - 穿模问题全过程：[`HANDOVER-clipping.md`](./HANDOVER-clipping.md)
  - 家具/平台/占用网格：[`HANDOVER-room-seats.md`](./HANDOVER-room-seats.md)
  - 动画播放与切换：[`ANIMATION.md`](./ANIMATION.md)
  - QQ 链路：[`QQ-LINK.md`](./QQ-LINK.md)　测试：[`TESTS.md`](./TESTS.md)　性能：[`PERF.md`](./PERF.md)

---

## 1. 系统组成

```
浏览器 /room/  ──HTTP──> bridge（Node，:3101）──> state/*.json（房间/菜园/会话）
     │                        │
     │                        ├──> DSH（对话/工具）
     │                        └──> SnowLuma（QQ 客户端，OneBot HTTP 3000 / WS 3001）
QQ 用户 ──> QQ ──> SnowLuma ──> AstrBot（:6185 面板 / :6199 OneBot 反连）
                                   └── 插件：room_link、proactive_chat、livingmemory、
                                       seed_audio_tts、dafeiyu_draw、dafeiyu_sing、
                                       qqprofile、qq_tools、meme_manager…
```

两套「她」共用同一份人设（AstrBot 人格库 `personas` → `大肥鱼`，1638 字），
房间侧没有独立角色卡（`/opt/dafeiyu-room/roles/` 只有示例文件）。

---

## 2. 云端拓扑

| 服务 | 端口 | 说明 |
|---|---|---|
| `dafeiyu-room`（bridge） | **3101** | 房间状态机 + API + 静态资源 |
| `nginx` | **3100** | 反代到 3101 |
| `astrbot` | **6185** 面板 / 6188 插件 / **6199** OneBot 反连 | QQ 机器人 |
| SnowLuma | 5099 WebUI / **3000** OneBot HTTP / **3001** WS / 5900 VNC | 托管于 AstrBot 插件 |
| 面板隧道 | 本地 **16185** → 服务器 6185 | `ssh -N -L 16185:127.0.0.1:6185 -i C:\Users\liato\.ssh\dafeiyu_cloud root@101.245.76.51` |

- 服务器：Ubuntu 24.04，2C2G，`/opt/dafeiyu-room`
- **服务器不通 GitHub**，只能本地 `deploy\cloud\deploy.ps1` 推送
- 已安装 ffmpeg/ffprobe（AstrBot 发 QQ 语音必需，见 §5）

---

## 3. 房间侧（bridge + 前端）

### 3.1 目录

```
src/          bridge.js（API/调度）、home-state.js（状态机）、garden-*、weather-store、
              volc-tts.js（豆包 TTS）、breeze-tts.js（Breeze，备用）、memory-*、social*
public/room/  index.html（UI/CSS）、app.js（主逻辑）、world.js（场景）、actor.js（立绘）、
              nav-data.js（导航，由 gen_nav_data 生成）、dev-editor.js、ambience.js…
deploy/       云端部署脚本、插件源（room_link、dafeiyu_draw）
scripts/      生成器、无头测试、截图工具、隧道脚本
```

### 3.2 常用 API

| 端点 | 用途 |
|---|---|
| `/api/home/state` | 房间快照（她/需求/事件/lawn） |
| `/api/home/act` | 交互（command/go/sleep/wake/lamp…） |
| `/api/room/chat` | 网页聊天（走 webchat → AstrBot） |
| `/api/send/private` `/api/send/voice` `/api/voice/send` | 操作者通道发消息/语音（控制台 token） |
| `/api/socialV2/say-voice` | AI 让她发语音（**仅 reserved2 模式**） |
| `/api/mode` | 切换模式：`chat` / `closed-agent` / `reserved` / `reserved2` |

### 3.3 状态文件（`state/`）

`home.json`（位置/需求/活动/事件）、`garden.json`、`room.json`、`sessions.json`、`weather.json`、`console-token`。

### 3.4 最近改动（2026-11）

- **动画起停**：`walking` 判定改为以服务端 `her.walking` 为主（不再靠 500ms 轮询的位移脉冲），离开走路也按紧急切换 → 起步/停下都即时。
- **片段驻留**：最短驻留改为**当前视频实际时长**（1.2–6s 夹取），避免动画没播完被切。
- **事件卡片**：`emit()` 记录 `roomLabel/spotLabel/activity/clip/kind/pose`，读档与视图层都保留，前端两行展示（地点·当时活动·片段）。
- 细节见 `ANIMATION.md`、`HANDOVER-clipping.md`。

### 3.5 房间语音（双引擎）

```
speakToVoice()
  ├─ 配了 Breeze key → 用 Breeze（config.breeze）
  └─ 否则用豆包 Seed Audio（config.volcTts）→ X-Api-Key 鉴权
```

- 当前 `volcTts` 配的是**新版 API Key**（`X-Api-Key`，不再需要 APP ID/Access Token，旧的保留可用）
- 发送链路：生成 mp3 → `sendVoiceForV2` → SnowLuma OneBot `send_private_msg`（record）
- **SnowLuma 端点必须显式配**，否则 `unauthorized`：
  ```json
  "snowluma": { "enabled": true,
    "homeDir": "/root/data/plugin_data/pulids_snowluma_go_to_astrbot/snowluma",
    "httpUrl": "http://127.0.0.1:3000", "accessToken": "<onebot_*.json 里的 http token>" }
  ```
- 开关：`socialV2.voice.enabled=true`、`socialV2.tools.sendVoice=true`（AI 通道还要求 `reserved2` 模式）

---

## 4. AstrBot 插件（`/root/data/plugins`）

| 插件 | 作用 | 备注 |
|---|---|---|
| `astrbot_plugin_room_link` | 注入房间状态、执行房间动作 | 主人 QQ 校验 |
| `astrbot_plugin_proactive_chat` | 主动消息 | 间隔 10–60 分钟，免打扰 0–8，未回复上限 4；**按句分段发送**（`segment_decorated_chain`/`calc_interval` 为本地补丁，勿删） |
| `astrbot_plugin_seed_audio_tts` | 豆包 TTS | **已支持 `api_key`（X-Api-Key）**；整条语音；仅当用户说「发语音/用语音/语音回/说给我听/念给我听」才发（`reply_probability=0`）；发送前检查 ffmpeg |
| `astrbot_plugin_dafeiyu_draw` | 生图工具 `draw_picture` | 双 provider：`zhipu`(CogView-4) / `qwen`(Qwen-Image-3.0)；当前 **qwen** |
| `astrbot_plugin_dafeiyu_sing` | 唱歌 | 同一豆包接口 + 内置旋律表，提示词驱动演唱 |
| `astrbot_plugin_qqprofile` | 改昵称/头像/签名的工具 | `qqprofile_set_avatar` 本地补丁：支持 `image` 参数 + 无 bot 时直连 SnowLuma |
| `astrbot_plugin_livingmemory` | 长期记忆 | 向量嵌入走 SiliconFlow `BAAI/bge-m3`；**本机 Ollama 已停用** |
| `astrbot_plugin_qq_tools` / `qzone` / `qqprofile` / `group_chat_plus` | QQ 工具、空间、资料、群聊 | — |
| `meme_manager` | 表情包 | 语义索引 `semantic.enabled=false`（未启用，不影响发表情） |
| `pulids_snowluma_go_to_astrbot` | 托管 SnowLuma/QQ | 负责 OneBot 配置同步 |

> 关键配置：`/root/data/cmd_config.json`（provider/persona/TTS 开关）、
> `/root/data/config/*.json`（各插件）、`/root/data/plugin_data/`（会话数据、记忆库）。

---

## 5. 语音链路（当前可用状态）

| 项 | 配置 |
|---|---|
| TTS 引擎 | 豆包 Seed Audio（`seed-audio-1.0`） |
| 鉴权 | `X-Api-Key: 5bd2c253-…b42e` |
| 开关 | `provider_tts_settings.enable=true`、`trigger_probability=0`、`seed_audio_reply_probability=0`、`whole_reply=true` |
| 触发 | **只有明确索要**才发（关键词见上） |
| 依赖 | **ffmpeg**（缺了会整条回复发不出去；插件已加守卫，缺 ffmpeg 时保持文字） |
| 房间侧 | `volcTts.apiKey`（同 key）、`speakToVoice` 优先 Breeze 否则豆包 |

已知限制：`/api/socialV2/say-voice`（AI 主动发语音）仅 `reserved2` 模式可用；当前房间模式为 `chat`。

---

## 6. 生图链路（当前可用状态）

- 插件：`astrbot_plugin_dafeiyu_draw`（源码在仓库 `deploy/plugins/`）
- 工具：`draw_picture(prompt, size)`，返回文字 + **图片内容**（模型能看到自己画的图）
- 命令：`/画 <描述>`（仅 owner）
- 当前 provider：**qwen**
  - 端点：`POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
  - body：`{model:"qwen-image-3.0", input:{messages:[{role:"user",content:[{text}]}]}, parameters:{size:"1024*1024"}}`
  - 同步返回 `output.choices[0].message.content[0].image`（URL）
  - 注意：`qwen-image` **不能用** text2image 异步端点（报 url error）；`wanx*` 才走异步 `/text2image/image-synthesis`
- 备用 provider：`zhipu`（CogView-4，`Authorization: Bearer`，同步返回 url）
- **配置持久化坑**：`_conf_schema.json` 里必须声明 `provider/qwen_api_key/qwen_model/qwen_endpoint`，否则 AstrBot 重启会把它们清掉（已补）

---

## 7. 部署与运维

```powershell
# 房间（代码 + 前端构建 + 资产增量）
powershell -ExecutionPolicy Bypass -File deploy\cloud\deploy.ps1
```

- 服务器不通 GitHub；`deploy.ps1` 走 git archive + scp + `apply-deploy.sh`
- 部署后自检：`room: 200`、`.deployed-commit`
- 备份：`/var/backups/dafeiyu/` 每日 04:00，保留 7 份
- 重启：`systemctl restart astrbot dafeiyu-room`
- 面板隧道：`scripts/astrbot-tunnel.ps1`（幂等，端口已监听则复用）→ http://127.0.0.1:16185/#/auth/login

---

## 8. 2026-11-15 之后修过的问题（避免重复踩）

| 日期 | 问题 | 根因 | 修复 |
|---|---|---|---|
| 11-18 | 生图配置重启后丢失 | `_conf_schema.json` 未声明新字段，AstrBot 清理未知键 | 补 schema |
| 11-17 | 起步/停下动画滞后 | 靠画面位移判走，轮询 500ms 导致脉冲 | 以 `her.walking` 为主 |
| 11-17 | 动画没播完被切 | 驻留固定 1200ms | 按片段实际时长（1.2–6s） |
| 11-17 | 事件卡片信息不全 | emit/读档/视图三层都只保留 5 字段 | 三层补齐 + CSS 网格列修正 |
| 11-15 | 主动消息一条收不到 | 之前改动删了 `segment_decorated_chain`/`calc_interval` | 补回方法 |
| 11-15 | 语音发不出、整条回复丢失 | 服务器缺 ffmpeg | 安装 + 插件加守卫 |
| 11-15 | 换头像不生效 | 工具无参数、只认消息附图；webchat 无 `.bot` | 加 `image` 参数 + 直连 SnowLuma 兜底 |
| 11-15 | 房间语音 `unauthorized` | `config.snowluma` 为空（无 homeDir/token） | 显式配置端点与 token |

---

## 9. 已知问题 / 技术债

1. 生图/语音费用需在各自控制台核对（豆包按分钟、Qwen/CogView 按张）。
2. `meme_manager` 语义索引未启用；如启用需指定 provider（服务器无 Ollama）。
3. 房间 `say-voice` 受模式限制（`reserved2`），`chat` 模式下 AI 不能主动发语音。
4. 前端立绘是 2D 平面，站家具时仍可能被近侧栏杆遮挡（`HANDOVER-clipping.md` 有完整说明）。
5. 主动消息未回复上限 4 条；达到后需用户回复才恢复。
6. 面板隧道是本地进程，电脑重启后会断，需要重新执行脚本。

---

## 10. 新会话接手清单

1. `git log --oneline -20` + 读本文和 `ANIMATION.md`
2. 起本地 `npm start` → `http://127.0.0.1:3101/room/` 确认能跑
3. 核对线上：`.deployed-commit`、`room: 200`、`systemctl is-active astrbot dafeiyu-room`
4. 要改房间逻辑：先看 `home-state.js` 状态机与 `HANDOVER-clipping.md` 的不变量
5. 要改插件：注意 AstrBot 的 `_conf_schema.json`（新增配置项必须声明）
6. 部署：`deploy\cloud\deploy.ps1`；失败先服务器上直接 `node src/bridge.js` 看堆栈
