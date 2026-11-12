# astrbot_plugin_room_link · 房间联动

把 3D 房间（feiyu-room-template）接到 AstrBot 主线，让**房间里的对话走 AstrBot 自己的管线**——
同一只大肥鱼的人格、同一套 livingmemory 记忆、同一批插件；同时让 QQ 能查她在房间干嘛、指挥她做事。

## 架构

```
房间网页 /room/ ──> 房间桥接(3100) ──HTTP──> AstrBot /api/plug/astrbot_plugin_room_link/*
                                              └─ webchat 队列 → AstrBot 管线（人格/记忆/插件）
QQ ──> SnowLuma ──> AstrBot(aiocqhttp) ──> room_status / room_command 工具
```

QQ 和房间是**两条独立会话**，不会互相抢消息。

## 接口

插件自己起服务（绕开面板 JWT 鉴权）：`http://127.0.0.1:6188/room/`

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/room/ping` | 健康检查 |
| GET | `/room/state` | 读当前状态 |
| POST | `/room/event` | 房间上报事件：`{location, activity, note, mood}` |
| GET | `/room/commands` | 房间拉取待执行指令 |
| POST | `/room/ack` | 房间确认执行：`{id}` |
| POST | `/room/chat` | 房间对话：`{text}` → `{reply}` |
| GET | `/room/diag` | 诊断：平台列表、webchat 可用性 |

配置了 `api_token` 时，所有请求要带请求头 `X-Room-Token: <token>`。

## QQ 侧能力

| 工具 / 命令 | 说明 |
| --- | --- |
| `room_status`（LLM 工具） | 问她「你在房间干嘛」时返回位置、动作、多久、最近做过什么 |
| `room_command`（LLM 工具） | 主人说「去厨房/去浇花/去睡觉」时写入待执行指令 |
| `/房间` | 直接看状态 |

## 记忆共享的前提

`livingmemory` 默认按会话隔离。要让房间和 QQ 共用记忆，把它的
`filtering_settings.memory_scope_mode` 改成 `user`，并让插件的
`webchat_username` 填**主人 QQ 号**（默认 `630151911`）。这样两边的记忆按同一个人归档。

## 前置条件

1. AstrBot 里要有 **webchat 平台**（`{"id":"webchat","type":"webchat","enable":true}`），
   否则消息进不了队列，`chat` 会超时。
2. 房间桥接（3100）要指向本插件，见下。

## 房间桥接补丁

在 `feiyu-room-template/app/config.json` 里加：

```json
"astrbot": { "baseUrl": "http://127.0.0.1:6185", "token": "" }
```

然后让桥接的 `roomChatReply` 优先走 AstrBot（见仓库里的 `bridge.patch.md`）。
