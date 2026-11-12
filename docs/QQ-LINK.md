# QQ ↔ 房间 联动协议

房间（`http://127.0.0.1:3100/room/`）和 QQ 侧通过 bridge 中转，两边共用**同一份 `home-state`**，
所以不会出现「QQ 说她在卧室、画面里在客厅」。

## 一、房间 → QQ（已实现）

### 1. 读状态：`GET /api/home/context`

带 `Authorization: Bearer <console-token>`（同源页面免 token）。

```json
{
  "ok": true,
  "line": "她在客厅·沙发上，窝在沙发上抱着抱枕看屏幕；有点累；不饿；不渴；心情还不错（68/100）。",
  "her": {
    "room": "living", "roomName": "客厅", "spot": "sofa", "spotLabel": "沙发上",
    "activity": "窝在沙发上，抱着抱枕看屏幕", "kind": "tv",
    "clip": null, "asleep": false, "walking": false, "pos": [6.3, 5.12]
  },
  "body": { "hunger": 0.3, "thirst": 0.32, "energy": 0.42, " bladder": 0.2, "pain": 0, "hygiene": 0.1 },
  "mood": { "label": "还不错", "mood": 68 },
  "weather": "clear",
  "hour": 19.2,
  "recentEvents": ["你喂了她一块小鱼干", "窝在沙发上看了一会儿电视"],
  "say": null
}
```

**建议用法**：QQ 回复前拉一次，缓存 15 秒，拼进系统提示：

```
【小屋此刻】{line}
【她刚做的事】{recentEvents.join('；')}
（这是房间里的真实状态，可以自然提到；不要每句都报状态。）
```

### 2. 状态推送：`POST {AstrBot}/room/event`（bridge 主动推）

bridge 每 10 秒推位置，动作发生时推事件：

```json
{ "type": "pet", "activity": "被摸头", "location": "客厅·沙发上", "room": "living", "silent": false }
```

`type` 取值：`pet / feed / water / play / talk / sleep / wake / lamp / command / go / place / clip / say`

### 3. 主动消息（可选，默认关）

`config.json`：

```json
{ "room": { "proactive": { "enabled": true, "kind": "private", "id": 123456789, "minGapMs": 1800000 } } }
```

触发：睡着 / 醒来 / 6 小时没来。同类节流 30 分钟。走 `bot.sendPrivateMessage`（或 group）。

---

## 二、QQ → 房间（已实现）

### 1. 直接调用（bridge 本机接口）

```http
POST /api/home/act
Content-Type: application/json

{ "action": "clip", "clip": "跳街舞" }     // 点播任意动画（268 个目录 + 基础片段）
{ "action": "say",  "text": "我在跳舞呢" } // 让她在房间气泡里说一句
{ "action": "command", "room": "balcony", "spot": "chair" }  // 去某处
{ "action": "pet" } / feed / play / water / sleep / wake / lamp / poke
```

`clip` 支持中文动画名（`action-catalog.js` 里的 268 条，或基础片段名如 `run_happy`）。

### 2. 队列方式：`GET {AstrBot}/room/commands`（bridge 每 5 秒轮询）

AstrBot 插件维护一个队列，元素形如：

```json
{ "id": "c-1", "action": "clip", "clip": "游泳" }
{ "id": "c-2", "action": "say", "text": "我先去洗个澡" }
{ "id": "c-3", "action": "go", "target": "阳台" }
{ "id": "c-4", "action": "act", "name": "water" }
```

执行完 bridge 会 `POST {AstrBot}/room/ack { id }`。

`action` 支持：`act`（摸头/喂/喝水/陪玩/哄睡/关灯/叫醒）、`go`（中文目的地）、
`clip`（点播动画）、`say`（说话）。

中文目的地由 bridge 的 `ROOM_DESTS` 正则解析，也支持 AstrBot 下发 `places` 自定义映射。

---

## 三、优先级与边界

```
紧急需求（憋 ≥0.82 / 渴 ≥0.86 / 饿 ≥0.88）  ← 最高
QQ 指令（command / clip / say，30 秒有效）    ← 打断空闲调剂与日程
空闲调剂（20~45 秒一次的自由动画）
日程轮换（书桌/沙发/餐厅/阳台）
```

- QQ 指令**不会打断睡觉**：睡着时先叫醒再执行
- 同一动作 30 秒冷却；bridge 侧 `homeActTimes` 限流 120 次/分钟
- 只有 `allowed(kind, id, cfg)` 白名单内的会话才能收发

---

## 四、AstrBot 插件侧（已升级到 room_link 0.2.0）

插件路径：`…\core\data\plugins\astrbot_plugin_room_link`

### 0.2.0 新增

| 改动 | 说明 |
|---|---|
| `_live_context()` | 每轮回复前拉 `GET /api/home/context`（10 秒缓存），拿实时位置/活动/需求/心情 |
| `_status_text_async()` | `/房间` 命令和 `room_status` 工具都改为实时；顺带带出「正在播的动画」「睡着了」「最近 3 条事件」 |
| `room_play(clip)` | **新工具**：点播动画。会先拉 `/api/home/clips` 做模糊匹配，再入队 `{action:"clip", clip}` |
| `room_say(text)` | **新工具**：让房间气泡说这句话，入队 `{action:"say", text}` |
| 事件记录 | `/room/event` 现在会存 `type`（pet/feed/water/clip/say…）和 `needs` 快照 |
| 房间对话提示词 | `/room/chat` 的注入前缀改用实时 context，不再用旧的 state.json |

新增配置项：

```json
{
  "use_live_context": true,
  "bridge_token": ""      // 留空则自动读 bridge_dir/state/console-token
}
```

### 装好之后怎么用（QQ 里）

| 你说 | 她会 |
|---|---|
| 「你在房间干嘛？」 | 调 `room_status`，回答实时状态（位置/活动/精力/心情） |
| 「去阳台躺会儿」 | 调 `room_command`，走到阳台躺椅 |
| 「跳个舞给我看」 | 调 `room_play("跳街舞")`，房间立刻播该动画 |
| 「跟房间里说一句 我回来了」 | 调 `room_say`，气泡显示 |
| `/房间` | 直接回一句状态 |

### 重载

改完插件代码需要在 AstrBot 面板「插件管理 → 重载」；
也可以重启 AstrBot 实例（本机 launcher 会自动重新拉起）。
