# 交接文档（总）：大肥鱼 · 小蓝鱼 3D 房间系统

> 面向接手的新会话/新模型。本文覆盖**整个系统**；家具/穿模/动画那一块的深潜见
> [`docs/HANDOVER-room-seats.md`](./HANDOVER-room-seats.md)。
> 只写本会话中**实际核实过**的内容；不确定的会标注「未核实」。

- 本地仓库：`C:\Users\liato\dafeiyu-room\app`（事实源）
- 线上：`http://101.245.76.51:3100/room/`
- 当前 HEAD：`c78a073`（docs 更新）

---

## 1. 系统定位与架构

这是一个「**3D 房间网页 + QQ 机器人**」的合体：

```
浏览器 /room/  ──HTTP──>  bridge（本项目 Node 进程，:3101）
     │                         │
     │                         ├──> DSH（DeepSeek Harness）Web API：人格/模型/工具
     │                         ├──> SnowLuma（QQ 客户端，:5099）──> QQ
     │                         └──> state/*.json（房间事实源）
     │
QQ 用户 ──> QQ ──> SnowLuma ──> AstrBot（:6185/:6199）──插件──> bridge /room/*、/api/home/*
```

两条数据流：

- **房间流**：bridge 维护角色状态机（位置/需求/日程/菜园），浏览器每 500ms 轮询 `/api/home/state` 渲染；用户点击通过 `/api/home/act` 回写。
- **对话流**：AstrBot 的 `room_link` 插件把 bridge 的 `/api/home/context`（她在哪、在做什么、天气、需求）注入给模型；模型回复经 AstrBot → SnowLuma → QQ；`/api/send/*` 也能主动发。

---

## 2. 运行拓扑

### 2.1 云端（Ubuntu 24.04，2C/1.7G，40G 盘）

| 服务 | 端口 | 说明 |
|---|---|---|
| `dafeiyu-room.service` | **3101** | `node src/bridge.js`，房间状态 + API |
| `nginx.service` | **3100** | 反代 3100 → 3101，站点 `deploy/cloud/nginx-room.conf` |
| `astrbot.service` | 6185 / 6188 / 6199 | QQ 机器人框架（6188 给插件 HTTP，6199 内部） |
| SnowLuma | **5099**（VNC **5900**） | Linux QQ 容器 + Xvfb，由 AstrBot 插件托管 |
| `dafeiyu-backup.timer` | — | 每日 04:00 备份 |

- Node：`v24.21.0`，项目要求 `>=22.13.0`
- 部署目录：`/opt/dafeiyu-room`；版本标记 `.deployed-commit` / `.deployed-at`
- **服务器不能访问 GitHub**，所有代码靠本地推送

### 2.2 本地开发

```powershell
# 首次
copy config.example.json config.json     # 再按需填 dsh / snowluma / ownerQQ
npm ci
```

开发要**两个进程**（前端已改成 Vite 构建，源码是裸 `import 'three'`，不能再让 bridge 直接 serve 源码）：

```powershell
npm start        # 终端 1：bridge，:3101（API + 状态机 + 静态资产回源）
npm run dev      # 终端 2：Vite 前端，:5173，热更新
# 打开 http://localhost:5173/room/  （dev server 把 /api、/room/assets 代理回 bridge）
```

生产构建：`npm run build` 输出到 `dist/room/`（内容哈希 JS/CSS）；bridge 有 `dist/room/index.html` 时优先服务构建产物，否则回退 `public/room/` 源码。

`state/` 是运行时数据（房间、菜园、会话），`config.json` 是本机配置，`dist/` 是构建产物，三者都**不提交**。

---

## 3. 仓库结构

```
app/
├─ src/                   服务端（Node，ESM）
│  ├─ bridge.js           主进程（~830KB）：HTTP API、DSH 会话、QQ 发送、状态机调度
│  ├─ home-state.js       大平层状态机（需求/日程/路线/坐具/菜园桥接），~112KB
│  ├─ room-state.js       旧小屋状态（好感/来访/留言）
│  ├─ garden-store.js     菜园读写 + 视图
│  ├─ garden-autonomy.js  菜园自主照料（规划/执行/天气影响）
│  ├─ weather-store.js    天气快照（客户端每 15s 上报，菜园与对话共用）
│  ├─ md-to-plain.js      出站文本 md→纯文本 + HTML 实体解码
│  ├─ social*.js / forward.js / qq-model-view.js / qzone.js   社交、转发、空间
│  ├─ memory-*.js / role-card.js / preset-prompt.js           记忆、角色卡、预设
│  ├─ token-*.js / model-prices.js / budget                   用量与预算
│  ├─ snowluma-conn.js / napcat-client.js                     QQ 网关连接
│  ├─ mcp-*.js                                                MCP 服务（SnowLuma 安全封装、搜索）
│  └─ dsh-client.js / v2-wait.js                              DSH 客户端与等待
├─ public/room/           浏览器端（Vite 构建，three 走 npm 依赖）
│  ├─ index.html          页面骨架 + UI/CSS + boot 错误处理（Vite 入口）
│  ├─ app.js              主逻辑（~187KB）：状态轮询、相机、UI、天气、动画调度
│  ├─ world.js            场景搭建（~133KB）：房间、家具、天空、粒子、占用网格
│  ├─ actor.js            2D 立绘播放器（三图层交叉淡化、脚底锚点）
│  ├─ actor3d.js / model-actor.js   3D 模型（可选）
│  ├─ ambience.js         环境音（程序化噪声 + CC0 采样）
│  ├─ nav-data.js         导航数据：nodes/edges/keepout/platforms/spots（与服务端 home-state.js 双源，见 §9）
│  ├─ garden-*.js|css     菜园前端（世界构建、UI、相机）
│  ├─ dev-editor.js       `?edit=1` 模型编辑器（选中/移动/旋转/补丁）
│  ├─ action-*.js         动作清单与目录
│  ├─ assets/             ~380MB 静态资产（311 个 webm 动画 + 2 个 glb + 贴图/音频；git 跟踪）
│  └─ vendor/             three.module.js 等（仅 dev 页面 garden-showcase 用；主模块已切 npm three）
├─ vite.config.js         Vite 构建配置（root=public/room，base=/room/，产物 dist/room）
├─ dist/room/             前端构建产物（内容哈希 JS/CSS，gitignored，部署时本地 build 上传）
├─ deploy/cloud/          部署与运维脚本（见 §7）
├─ scripts/               生成器、测试、无头验收工具（见 §8）
│  ├─ build-asset-manifest.mjs   资产 sha256 清单（部署增量上传用）
│  └─ garden-probe.mjs           菜园合批探针（InstancedMesh/三角形/包围盒对照）
├─ docs/                  文档（本文件 + HANDOVER-room-seats.md + 其他）
├─ state/                 运行时状态（不提交）
├─ config.json            本机配置（不提交）
└─ package.json           start / dev / build / 大量 test:* 脚本
```

> 仓库里残留了一批 `*.bak-*` 文件（`world.js.bak-fix1..10`、`app.js.bak-sky` 等），是历史修补的备份，**不参与运行**，可在确认无回滚需求后清理。

---

## 4. 服务端：bridge 与状态机

### 4.1 API 分组（来自 `src/bridge.js` 路由表）

| 分组 | 代表端点 | 用途 |
|---|---|---|
| 房间 | `/api/home/state`、`/api/home/act`、`/api/home/context`、`/api/home/clips`、`/api/home/nav`、`/api/home/weather` | 状态、交互、给模型用的上下文、动作清单、导航、天气上报 |
| 旧小屋 | `/api/room/state`、`/api/room/act`、`/api/room/chat`、`/api/room/inspect` | 兼容旧页面 |
| 菜园 | `/api/garden/state`、`/api/garden/act`、`/api/garden/control` | 查看/操作/开关自主照料 |
| 发送 | `/api/send/private`、`/api/send/group`、`/api/send/reply`、`/api/send/voice` | 主动发 QQ |
| 社交 V2 | `/api/socialV2/*`（约 40 个） | 消息、表情包、空间、记忆、唤醒、发送队列 |
| 设置/角色 | `/api/roles*`、`/api/presets`、`/api/preset/sim-prompt*`、`/api/slang*` | 角色卡、预设、黑话学习 |
| 用量 | `/api/tokens/*`、`/api/status`、`/api/security` | Token 统计、状态、安全检查 |
| 调试 | `/api/debug/client` | 浏览器上报（穿模/漂移诊断用） |
| 静态 | `/room/`、`/guide/` | 房间页面、指南 |

### 4.2 状态文件（`state/`）

| 文件 | 内容 |
|---|---|
| `home.json` | 大平层事实：位置/需求/睡眠/活动/路线/坐具/事件 |
| `garden.json` | 菜园：地块、作物、金币、种子、照料任务 |
| `room.json` | 旧小屋：好感、来访、留言 |
| `sessions.json` | DSH 会话状态 |
| `weather.json` | 天气快照 `{key,intensity,at}` |
| `client-debug.log` | 浏览器遥测（`?edit=1` 或 dev 模式时上报） |
| `console-token` | 控制台访问令牌（API 鉴权用） |

### 4.3 状态机要点（`home-state.js`）

- `HOME_LAYOUT.spots`：每个可交互位置的 `pos/pose/support/mount/access`
- `SURFACES`：支撑面高度（`sofa_seat 0.48`、`bed_top 0.54`、`balcony_chair 0.40`、`pool_lounger 0.445`…）
- `HOME_PLATFORMS`：可站立平台（从 spots 派生，含 `rect/top/climb`）
- `NAV_KEEPOUT`：纯障碍；`NAV_BLOCKS = KEEPOUT + 平台投影`（寻路用）
- `beginRoute` → `arrive` → `mounting/dismounting`（两段式）→ `dwell`
- 输出 `homeView()`：`her`（位置/姿态/高度/活动/是否过渡）、`layout.platforms`、`env`、`weather`

> 细节（不变量、测试指标、排障）见 `HANDOVER-room-seats.md`。

---

## 5. 浏览器端（`public/room/`）

> **构建链**：前端用 Vite 构建（`npm run build` → `dist/room/`），`import 'three'` 走 npm `three@0.160.0`（tree-shake + minify），产物内容哈希 JS/CSS（`_vite/index-<hash>.js`）。开发 `npm run dev`（:5173，热更新）。`index.html` 内联的 `<style>` 和 boot 错误处理脚本保留内联。dev 页面（`garden-showcase.html` 等）仍引用 `vendor/three.module.js`，走 bridge 静态回源。

- **渲染**：three.js；`world.js` 建场景并做静态合批（`mergeStaticDecor`，合批前必须刷新 `matrixWorld`）
- **角色**：`actor.js` 2D 立绘，三层交叉淡化；`clipFor()` 决定当前片段（走/坐/睡/动作），`app.js` 里做最短保持
- **天气**：客户端选择或自动轮换，粒子/雾/地面湿滑在 `world.updateEnvironment`；`ambience.js` 按天气+时段出环境音
- **菜园**：`garden-world.js` 建菜园场景，`garden-ui.js` 面板，`garden-state.js` 与服务端同构的规则
- **导航调试**：`?nav=1` 画路点/连线/禁区；`?edit=1` 打开模型编辑器
- **调试钩子**（`window`）：`__getWorld()`、`__camera`、`__VIEW`、`__setMode()`、`__setFP()`、`__devEditor`、`__drawState`（角色实际绘制位置/高度/片段）、`__ambience`、`__homeErrors`
- **常用 URL 参数**（以代码为准）：`sky`、`hour`、`edit`、`nav`、`animdbg`、`skymenu`、`petgroup`、`preview`、`pintest`、`clickmove`、`sound`、`view`

---

## 6. QQ 链路（AstrBot + SnowLuma + 插件）

服务器上 AstrBot 插件目录（`/root/data/plugins`）：

```
astrbot_plugin_room_link       与 bridge 对接：注入房间上下文、执行房间动作
astrbot_plugin_proactive_chat  主动消息（按句拆分发送、历史压平换行）
astrbot_plugin_dafeiyu_sing    唱歌
astrbot_plugin_group_chat_plus 群聊增强
astrbot_plugin_livingmemory    长期记忆
astrbot_plugin_memewiki        表情包维基
astrbot_plugin_meme_manager    表情包管理
astrbot_plugin_qqprofile       QQ 资料
astrbot_plugin_qq_tools        QQ 工具
astrbot_plugin_qzone           QQ 空间
astrbot_plugin_seed_audio_tts  TTS 音色
pulids_snowluma_go_to_astrbot  SnowLuma/QQ 客户端托管
```

- **room_link**：轮询 `bridge /room/*` 指令队列；每轮把 `/api/home/context` 的 `line`（含位置/需求/天气）注入；动作通过 `/api/home/act` 下达。
- **proactive_chat**：主动消息的切句逻辑已改为统一按「句末标点或换行」拆分（`sender_service.split_text`），历史注入前压平换行（模型会模仿历史排版）。
- **SnowLuma**：Linux QQ 跑在 Xvfb `:99`，可用 `xdotool` + `scrot` 远程操作/截图；被本地登录挤下线时会在界面弹「下线通知」。

---

## 7. 部署与运维（完整版）

### 7.1 日常部署

```powershell
# 本地仓库根目录
powershell -ExecutionPolicy Bypass -File deploy\cloud\deploy.ps1
```

参数：`-AllowDirty`（带未提交改动部署）、`-NoRestart`（只上传不解包）、`-FullAssets`（资产不做增量，强制全量）、`-Server/-User/-Key/-AppDir`。

流程（**三分通道**，不再 380MB 全量）：
1. **代码包**：`git archive`（排除 `public/room/assets`）→ 约 4.4MB
2. **资产包**：`scripts/build-asset-manifest.mjs` 生成 sha256 清单，与服务器 `assets-manifest.json` diff；**只有变更才** `git archive public/room/assets`（~377MB）。用 git archive 而非 tar.exe（Windows tar.exe 处理不了中文文件名）
3. **构建产物**：本地 `npm run build` → `dist/room/`（~1.6MB）
4. scp 三包 + 清单 + apply-deploy.sh → 服务器 `stop → 解包代码 → 清空并解包 dist → 解包资产(若变) → 更新 manifest → lock 变了才 npm ci → start → 自检`

耗时：常规（资产/依赖未变）约 15–30 秒；依赖变了加 ~30s；资产变更或首次部署加 377MB 上传（看带宽 1–6 分钟）。

### 7.2 验证

```bash
ssh -i C:\Users\liato\.ssh\dafeiyu_cloud root@101.245.76.51 \
  'bash /opt/dafeiyu-room/deploy/cloud/check-drift.sh'   # 版本 + 资产清单抽查
curl -s -o /dev/null -w "%{http_code}\n" http://101.245.76.51:3100/room/
# 非回环访问需要 consoleToken（401 正常）；回环自检见 apply-deploy.sh 末尾
```

> ⚠️ `nginx-room.conf`（§7.6）加了静态直出 + gzip，但 `deploy.ps1` **不自动更新 nginx 配置**。要启用需在服务器手动执行一次：
> `install -m 644 deploy/cloud/nginx-room.conf /etc/nginx/sites-available/dafeiyu-room && nginx -t && systemctl reload nginx`
> 未更新前 assets 仍走 bridge（功能正常，仅少 nginx 层缓存优化）。

### 7.3 首次安装 / 灾备

```bash
bash deploy/cloud/install.sh                  # 房间 + nginx + 备份
bash deploy/cloud/install.sh --with-astrbot   # 追加 AstrBot 与插件
```

### 7.4 备份 / 回滚

```bash
bash deploy/cloud/backup.sh                 # 默认脱敏 Key/token
KEEP_SECRETS=1 bash deploy/cloud/backup.sh  # 保留原始密钥
FULL=1 bash deploy/cloud/backup.sh          # 含表情包图库（~900MB）
```

回滚 = 本地 `git checkout <旧提交>` 后重新部署；`state/` 不会被覆盖。

### 7.5 排障速查

| 现象 | 处理 |
|---|---|
| 部署报「服务器端部署失败」 | `cd /opt/dafeiyu-room && node src/bridge.js` 直接跑看堆栈 |
| 服务反复重启 | `journalctl -u dafeiyu-room -n 40`；`state/bridge.log` |
| 页面 502 | bridge 没起来 |
| 刷新没变化 | 查 `cache-control`；`Ctrl+F5` |
| 版本对不上 | `cat /opt/dafeiyu-room/.deployed-commit` |
| 云端 `git pull` 失败 | 正常，服务器不通 GitHub |
| `deploy.ps1` 报「assignment expression is not valid」 | `.ps1` 缺 UTF-8 BOM 时 PowerShell 5.1 会把中文注释解析坏；用 `Get-ChildItem -Recurse *.ps1` 检查并补 BOM（本仓库已统一带 BOM） |

> 本会话踩过：`home-state.js` 里 `NAV_BLOCKS` 在初始化前被引用 → 服务启动即崩；修复是对 `NAV_KEEPOUT` 做回填（`c1b45ac`）。

### 7.6 其他脚本

`apply-deploy.sh`（服务器端解包）、`check-drift.sh`（版本/漂移）、`update.sh`（仅说明）、`sync-plugins.sh`（插件同步）、`10-bootstrap.sh` / `20-astrbot.sh`、`set-embedding-siliconflow.sh`。

---

## 8. 开发与调试工具

| 工具 | 用途 |
|---|---|
| `scripts/page-eval.mjs` | 打开页面执行 JS 并取回结果（最常用） |
| `scripts/page-diag.mjs` / `visual-check.mjs` / `audio-check.mjs` | 页面诊断、视觉/音频检查 |
| `scripts/render-view.mjs` | 指定相机渲染单帧 PNG |
| `scripts/seat-check.mjs` | 同页内依次去四个座位抓图 |
| `scripts/capture-mount.mjs` | 上座过程逐帧抓图 |
| `scripts/smoke-path.mjs` | **主验收**：10 段路径逐帧检测穿模/跳变/片段切换 |
| `scripts/isolate-render.mjs` | 只渲染指定颜色材质（排查「在但看不见」） |
| `scripts/home-preview.mjs`、`room-shot.mjs` | 房间预览/截图 |
| `npm test` 系列（`test:room`、`test:home`、`test:garden`、`test:project` 等） | 回归测试 |
| `npm run perf:check` | 性能检查 |

无头 Chrome 在 swiftshader 下冷启动约 12–35 秒，等待时间要留足（本会话多次因为等得不够导致误判「页面没加载」）。

---

## 9. 已改动 / 需知的行为约定

1. **天气双源**：页面决定天气，每 15s `POST /api/home/weather`；服务端 `weather.json` 供菜园与对话使用。黎明/黄昏/夜晚由时间决定，不再是天气选项。
2. **菜园受天气影响**：下雨自动补水、下雪暂停生长、雷雨偶发损坏。
3. **主动消息**：固定按句拆分发送；历史里的换行会被压平（防止模型照抄）。
4. **家具是独立分区（不是 K 区）**：`NAV_KEEPOUT` 只剩墙/水等障碍；沙发/床/躺椅等是 `HOME_PLATFORMS`（每个带 `rect` + `top` + 攀爬点）。平台矩形**照样阻挡路线**（`NAV_BLOCKS` 参与全部寻路段判定），只有「该平台自己的座位点」允许作为端点豁免；地面高度进不去，只能走到攀爬点再抬升进入。调试层里 K 区是红色、平台是青色（带高度柱和攀爬点标记）。
5. **动画**：片段最短保持 350ms；坐姿兜底只对 idle/free/sit 生效。

---

## 10. 已知问题与技术债

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| 1 | 2D 立绘被家具近侧栏杆遮挡（遮挡≠相交） | 观感像穿模 | 已加 0.22m 朝相机偏置；根治需坐姿素材 |
| 2 | 窄座椅（阳台/沙滩躺椅）宽度接近立绘宽度 | 站上去边缘悬空 | 改为「站椅子旁」或补坐姿素材 |
| 3 | 平台数据在服务端与客户端各一份 | 由 `scripts/gen_nav_data.mjs` 从 `home-state.js` 生成 `nav-data.js`，已自动同步；手改 `nav-data.js` 会在下次生成时被覆盖 | 只改 `home-state.js`，然后 `node scripts/gen_nav_data.mjs` |
| 4 | ~~`public/room/*.bak-*`、`src/bridge.js.bak-nav` 等备份文件~~ | 已于 2026-11-15 清理（15 个文件 / 1.9MB，均未被引用）；调试截图 596 张（342MB）移入 `_trash-2026-11-15/` | 完成 |
| 5 | 无头测试依赖固定 sleep | 偶发误判 | 改成轮询就绪状态 |
| 6 | AstrBot 侧多个插件有 `.bak` 配置 | 混淆 | 归档 |

---

## 11. 新会话接手清单（建议前 30 分钟）

1. `git log --oneline -15` 看最近改动，读 `docs/HANDOVER.md` 与 `docs/HANDOVER-room-seats.md`
2. `npm start` 起本地，打开 `http://127.0.0.1:3101/room/` 确认能跑
3. `node scripts/smoke-path.mjs <输出目录>` 跑一遍主验收，确认 0 穿模
4. 线上核对：`check-drift.sh`、`room: 200`、`.deployed-commit` 与本地 HEAD
5. 要改房间逻辑前，先看 §4.3 的状态机要点与 seats 文档的「不变量」
6. 要部署：直接 `deploy\cloud\deploy.ps1`，失败先本地 `node --check` + 服务器直跑 bridge

---

## 12. 最近相关提交

```
c78a073  docs: 交接文档补充完整服务器部署章节
4b3634f  docs: 房间可站立家具/穿模/动画系统交接文档
283715e  fix(room): 床面抬升仅休息状态生效；统计动画快速切换次数
902922d  fix(room): 躺姿抬升只在真正躺下时生效；跳变按阶段统计
65b03a5  fix(room): 过渡后 300ms 不套用落点解，高度限制在座面附近
c1b45ac  fix(room): 修复 NAV_BLOCKS 初始化顺序（服务启动崩溃）
348ad09  feat(room): 座面区域地面高度不可直接进入 + 冒烟覆盖上下往返
ce7718a  feat(room): 座面内搜索最佳落点 + 冒烟测试脚本
```
