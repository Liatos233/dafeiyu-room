# 大肥鱼的家 · dafeiyu-room

一个能自己过日子的 **3D 房间**，和住在 **QQ** 上的同一个「她」。

浏览器里是一套可自由走动、能投屏、能种菜的 three.js 大平层；QQ 那头通过 AstrBot 插件连回这个房间——你在 QQ 上问她「在干嘛」，她答的就是房间里真实发生的事。两边共用同一份状态、同一份记忆、同一套人格。

[安装指南](SETUP.md) · [让 AI 帮你装](AI_SETUP_PROMPT.md) · [QQ ↔ 房间联动](docs/QQ-LINK.md) · [安全与部署约定](docs/SECURITY.md) · [问题反馈](https://github.com/Liatos233/dafeiyu-room/issues)

> [!IMPORTANT]
> **这是一个可自托管的项目，不是作者本人的运行存档，也不隶属于 SnowLuma、DeepSeek 或腾讯 / QQ。**
> 仓库不包含作者的角色卡、QQ 号、群号、聊天记录、记忆、语音、照片、API Key 或 Cookie。所有服务地址、账号、密钥都要你自己在 `config.json` 里填。

## 它现在长什么样

```text
                    ┌──────────────── 浏览器 ────────────────┐
   /room/  ────────▶ │  three.js 房间 / 菜园 / 电视 / 陪伴层   │
                    └───────────────┬───────────────────────┘
                                    │  /api/home/*（本机回环）
                    ┌───────────────▼───────────────────────┐
                    │  qq-bridge  (Node, src/bridge.js)     │
                    │  ├── 房间状态 / 寻路 / 事件日志        │
                    │  ├── 记忆卡 / 菜园自主照料 / 预算      │
                    │  └── DSH 客户端 + MCP server          │
                    └───────┬───────────────────┬───────────┘
                            │                   │
                    ┌───────▼────────┐   ┌──────▼──────────────┐
                    │ DeepSeek       │   │ SnowLuma（可选）     │
                    │ Harness Web    │   │ OneBot ← AstrBot     │
                    │ （人格 / 模型）│   │ ← QQ                 │
                    └────────────────┘   └─────────────────────┘
```

| 模块 | 现在的样子 |
| --- | --- |
| 3D 房间 | 客厅、厨房、餐厅、卧室、卫生间、阳台、玄关、走廊、屋后菜园；昼夜与天气、第一视角、地图寻路并自动避开大件家具 |
| 动作库 | **269 段动作**，分 9 组：吃喝 45 / 其它 52 / 起居 36 / 才艺 33 / 玩耍 26 / 运动 24 / 情绪 21 / 工作 18 / 节日 14 |
| 自主行为 | 空闲 20~45 秒抽一件事做，按心情、天气、时段加权，最近 5 条不重复；一半会走到对应家具旁再执行 |
| 菜园 | **8 畦**地、**12 种**作物（萝卜 / 胡萝卜 / 生菜 / 番茄 / 黄瓜 / 茄子 / 青椒 / 南瓜 / 玉米 / 草莓 / 土豆 / 白菜），翻土→播种→浇水→施肥→采收→出售，也能自主照料 |
| 事件日志 | 右上「刚刚发生」：出发 / 到达 / 做完 / 需求越线 / 心情变化 / QQ 指令，保留 6 小时 |
| QQ 联动 | `GET /api/home/context`·`clips`·`state`·`nav`·`weather`，`POST /api/home/act`（`clip` / `say`）；配套 AstrBot 插件提供 `room_status` / `room_command` / `room_play` / `room_say` |
| 房间私聊 | 网页内直接和她聊，不经过 QQ，记录只存在浏览器 localStorage |
| 电视投屏 | `getDisplayMedia` 把标签页共享进房间电视，50% / 80% / 全屏 |
| 陪伴层 | 左下角 2D 立绘陪你看电视，可调大小、开关气泡、截取电视画面说观后感 |
| 控制台 | 切换模式、白名单、日志、token 用量 |
| 部署 | `deploy/cloud` 一键装到 Linux 云主机，`deploy/data` 备份与状态同步，`deploy/local` 本机脚本 |

## 和上游的关系

这个项目**起步于** [sh2234113/feiyu-room-template](https://github.com/sh2234113/feiyu-room-template)（作者 sh2234113）的「大肥鱼房子模板」，代码沿用 MIT。但**现在已经不是那个模板的镜像**了——下面是这一路自己加/改/重写的部分：

| 方向 | 具体做了什么 |
| --- | --- |
| 动作与自主性 | 重建为 269 条带元数据的动作目录（点位 / 时段 / 权重），加上按心情天气加权的自主调度；新增 `swim.webm`、`phone.webm` |
| 事件与可观测 | 详细事件日志、token 账本与预算、性能与测试文档（`docs/TESTS.md`、`docs/PERF.md`） |
| QQ 侧 | 全新的 `/api/home/*` 联动接口；AstrBot 插件 `room_link`（房间状态 / 指令 / 播放 / 说话）与 `dafeiyu_draw`（真去画图） |
| 前端 | 右侧卡片统一宽度间距、房间名开关、泳池第一视角、座位与寻路修正 |
| 工程化 | `deploy/` 全套部署与备份脚本、`scripts/` 下 50 多个测试/探针/截图脚本、`docs/` 里 12 篇交接与专题文档 |
| 安全 | SSH 只留密钥、fail2ban、仓库脱敏与提交前自查，见 [docs/SECURITY.md](docs/SECURITY.md) |

> 想要上游最初那一版的效果，直接用上游仓库；本项目的行为、素材体积和依赖都不同了。

## 目录

```text
src/                 桥接与后端核心
  bridge.js          HTTP 服务、房间 API、QQ 消息流水线、MCP
  home-state.js      房间状态、寻路、事件日志
  memory-card.js     记忆卡、日记
  garden-autonomy.js 菜园自主照料
  token-ledger.js    模型用量账本与预算
public/room/         房间前端（three.js / 菜园 / 电视 / 陪伴层 / 动作目录）
public/console.html  本地控制台
plugins/             两个 DSH 插件：qq-agent-presets、qq-mode-console
dsh/                 qq-chat / qq-chat-v2 preset 源
deploy/
  cloud/             一键部署到云主机（nginx、systemd、证书说明）
  data/              备份拉取 / 状态同步
  local/             本机启停脚本
  patches/           线上热修脚本（有注释说明起因）
  plugins/           随仓库分发的 AstrBot 插件
scripts/             安装、启动、截图、测试、探针
docs/                交接与专题文档（见下方索引）
roles/               示例角色卡
```

运行后会生成 `config.json`、`state/`、`audio/`、`assets/`、`dist/`、`backups/` 等本地数据，均已被 `.gitignore` 排除。

## 快速开始

依赖：

- **Node.js >= 22.13**
- **DeepSeek Harness**（按 `0.2.1-rc.2` 的 API / preset 机制编写，见 [SETUP.md](SETUP.md)）
- **SnowLuma**（可选，只影响 QQ，需单独安装）
- Chrome / Edge（投屏需要 `getDisplayMedia`）

```bash
git clone https://github.com/Liatos233/dafeiyu-room.git
cd dafeiyu-room
npm ci
cp config.example.json config.json      # Windows: Copy-Item config.example.json config.json
```

编辑 `config.json`，至少核对这几项：

| 字段 | 填什么 |
| --- | --- |
| `ownerQQ` | 你自己的 QQ，只填自己 |
| `allow.private` / `allow.groups` | 允许接入的 QQ / 群；空白名单则不响应任何会话 |
| `consoleToken` | 自己生成一长串随机字符，别发群里 |
| `dsh.baseUrl` | DSH Web 地址，默认 `http://127.0.0.1:3080` |
| `dsh.provider` / `dsh.model` | 必须是你环境里真实可用的 provider/model |
| `snowluma.wsUrl` / `httpUrl` | OneBot 地址，默认 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000` |
| `snowluma.accessToken` | SnowLuma 配了 token 才填 |
| `room.access` | 默认 `loopback`，房间只允许本机回环访问 |

装 preset 与 MCP（会注册 `qq-chat` / `qq-chat-v2` preset、三个 MCP server 和两个 DSH 插件）：

```bash
node scripts/setup-dsh.mjs
```

**装完必须重启 DSH Web**，否则 preset 和工具不生效。然后启动：

```bash
npm start          # 或 Windows 双击 scripts/start.bat，macOS/Linux 用 scripts/start.sh
```

打开 <http://127.0.0.1:3100/room/>（**必须带结尾 `/`**，`/room` 会 302，相对路径可能解析错）。

验收：

```bash
npm run test:all
```

或至少跑 `npm run test:room`、`npm run test:home`、`npm run test:garden`、`npm run test:mcp-servers`，再看一眼浏览器：进菜园能返回、8 畦地 12 作物都在、投屏能选标签页、陪伴层出现且滑块可用、刷新无 500。更多测试见 [docs/TESTS.md](docs/TESTS.md)。

## QQ 侧：AstrBot 插件

房间本身不需要 AstrBot；要接 QQ 才需要。**仓库里随代码分发的只有两个**（`deploy/plugins/`）：

| 插件 | 作用 |
| --- | --- |
| `astrbot_plugin_room_link` | 房间状态、下达动作、播放片段、让她说话；走 `/api/home/*` |
| `astrbot_plugin_dafeiyu_draw` | 给她一个真的画画工具（智谱 CogView-4），画完发到当前会话 |

**其余插件都不属于本仓库**，是各自作者维护的第三方项目，装了才装、没装也能跑。作者实际那套环境里还用了下面这些，仅供你参考组合方式——请到各自仓库按它们的许可证安装：

| 类别 | 插件 | 上游 |
| --- | --- | --- |
| 长期记忆 | `astrbot_plugin_livingmemory` | `lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory` |
| 查梗 | `astrbot_plugin_memewiki` | `in1t1a1/astrbot_plugin_memewiki` |
| 表情包 | `meme_manager` | `anka-afk/astrbot_plugin_meme_manager` |
| 主动消息 | `astrbot_plugin_proactive_chat` | `Pancakes-Labs/astrbot_plugin_proactive_chat` |
| 群聊读空气 | `astrbot_plugin_group_chat_plus` | `Him666233/astrbot_plugin_group_chat_plus` |
| QQ 操作 | `astrbot_plugin_qq_tools`、`astrbot_plugin_qqprofile`、`astrbot_plugin_qzone` | `YUMU1658/...`、`Zhalslar/...` |
| B 站 | `astrbot_plugin_bili_whale` | `DrKthrose/astrbot_plugin_bili_whale` |
| OneBot 适配 | `pulids_snowluma_go_to_astrbot` | `SATA-F5/Snowluma-Go` |

## 部署到服务器

```bash
# 云主机（Ubuntu/Debian，装 nginx + systemd 服务）
bash deploy/cloud/install.sh
```

本机向服务器推送代码与增量资产：

```powershell
# 先设一次服务器地址（不写进仓库）
setx DAFEIYU_SERVER <你的服务器IP>
powershell -ExecutionPolicy Bypass -File deploy\cloud\deploy.ps1
```

备份与状态互传见 `deploy/data/`。部署脚本会检查 `ssh-agent` 里有没有密钥，缺了直接提示怎么修，不会静默失败。细节见 [docs/deploy/CLOUD-MIGRATION.md](docs/deploy/CLOUD-MIGRATION.md) 和 [docs/SECURITY.md](docs/SECURITY.md)。

## 安全

这个仓库**不含任何密钥**：所有地址、账号、API Key 都在 `config.json`（已 gitignore）和环境变量里。提交前建议自查一遍：

```bash
npm run privacy-scan
git grep -n -I -E "BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9_-]{16,}|ghp_|AKIA|AIza"
git grep -n -I -E "[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|[A-Za-z]:\\\\?Users\\\\?"
```

**绝对不要提交 / 外传**：`config.json`、`_migrate/`（含完整配置与真实 API Key）、`backups/`、`*.tar.gz`、`__pycache__/`。服务器侧的加固（SSH 只留密钥、fail2ban、密钥轮换）记在 [docs/SECURITY.md](docs/SECURITY.md)，改之前先读那一页。

## 文档

| 我想…… | 入口 |
| --- | --- |
| 从零安装、配置、排查 | [SETUP.md](SETUP.md) |
| 让另一个 AI 接手安装 | [AI_SETUP_PROMPT.md](AI_SETUP_PROMPT.md) |
| QQ 和房间怎么联动 | [docs/QQ-LINK.md](docs/QQ-LINK.md) |
| 加新动作 / 改动画 | [docs/ANIMATION.md](docs/ANIMATION.md) |
| 跑测试、看覆盖 | [docs/TESTS.md](docs/TESTS.md) |
| 性能与开销 | [docs/PERF.md](docs/PERF.md) |
| 服务器加固与密钥 | [docs/SECURITY.md](docs/SECURITY.md) |
| 部署到云端 | [docs/deploy/CLOUD-MIGRATION.md](docs/deploy/CLOUD-MIGRATION.md) |
| 用 NapCat 接 QQ | [docs/guides/NAPCAT.md](docs/guides/NAPCAT.md) |
| 上传到 GitHub | [GITHUB_UPLOAD.md](GITHUB_UPLOAD.md) |
| 隐私与素材边界 | [PRIVACY_AND_ASSETS.md](PRIVACY_AND_ASSETS.md) |
| 灵感来源与署名 | [INSPIRATION.md](INSPIRATION.md) |
| 第三方许可证 | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |

## 素材与许可

- **代码**：MIT，见 [LICENSE](LICENSE)。
- **2D 立绘与动作素材**：形象源自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，精灵图实际取自 [aboutme-pets](https://github.com/hunmer/aboutme-pets)，按 **CC BY-NC-SA 4.0** 使用（署名、非商业、相同方式共享）。详见 [CREDITS](public/room/assets/pet/CREDITS.md)。
- **动作动画**：`public/room/assets/pet-import/`（114 个）为原始 webm，`pet-gen/`（164 个）由精灵图逐帧转码，均沿用 CC BY-NC-SA 4.0。
- **新动作** `swim.webm` / `phone.webm`：AI 生成 + ffmpeg 抠像，形象源自 dsh-pet，同样 CC BY-NC-SA 4.0。
- **Three.js**：MIT，见 `public/room/vendor/LICENSE-three.txt`。
- **3D 模型**：附 `da-feiyu.opt.glb`（6.7 MB，页面实际加载）与 `da-feiyu.glb`（约 56 MB 原始工程备份）。版权归作者，仅用于展示，不可单独转售或商用。
- **SnowLuma**：独立专有软件，不在本仓库内，也不随本仓库分发。
- **AstrBot 第三方插件**：各自授权，不属于本仓库，安装前请读上游许可证。

## 使用边界

- 只在你知情并获准的会话里用，遵守平台规则；非官方 QQ 后端可能导致账号受限。
- 聊天内容会经 DSH 发给你配置的模型服务；电视截屏观后感会把截图发给支持图片输入的模型。
- 本项目不实现 QQ 登录或 OneBot 协议，也不安装 / 打包 / 启停 SnowLuma。
- 电视投屏是浏览器标签页镜像，声音仍在原标签页。
- 模板附带作者的展示模型，但不含作者的人格、私人记忆和语音——**代码与界面接近 1:1，私人身份不 1:1**。
