# 迁移到云服务器（Ubuntu 24.04）

服务器：`101.245.76.51`（Ubuntu 24.04，2C2G，40G 盘，2Mbps，100G/月）
目标：AstrBot + QQ(NapCat) + dafeiyu-room 上云；DSH 暂留本机，通过隧道供云端调用。

## 架构

```
手机/浏览器 ──> 101.245.76.51:3100  房间（Node bridge + 静态站）
                     │
                     ├── AstrBot :6188（插件 room_link）
                     │        │
                     │        └── 房间桥接（同机 127.0.0.1:3100）
                     │
                     └── NapCat（QQ 客户端，OneBot WS/HTTP :3000/:3001）
                              │
                              └── 房间 bridge 把 QQ 消息转给 DSH

本机(Windows) DSH Web ──frpc──> 服务器 frps :7000 ──> 127.0.0.1:3080（bridge 配置的 DSH 地址）
```

## 阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0 | 初始化：swap 4G、Node 24、Python venv、ufw、时区 | `node -v` = 24.x，`free -h` 有 4G swap |
| 1 | AstrBot + `astrbot_plugin_room_link` | 面板可开，`/room/ping` 返回 ok |
| 2 | NapCat + QQ 扫码登录 | OneBot 的 `/get_login_info` 返回账号 |
| 3 | dafeiyu-room（bridge + 房间 + 376MB 素材） | `http://101.245.76.51:3100/room/` 打开，房间有状态 |
| 4 | 隧道打通 DSH | bridge 能拿到 DSH 回复，QQ 里说话她能动 |
| 5 | 数据迁移（state/记忆/角色卡）+ systemd 常驻 + 备份 | 重启服务器后自动恢复；备份可回滚 |
| 6 | （可选）DSH 迁移到 Linux | `dsh web` 在 Ubuntu 跑通 |

## 端口规划

| 端口 | 用途 | 对外 |
|---|---|---|
| 3100 | 房间 + bridge API | 是（受 token 保护） |
| 6188 | AstrBot 插件 HTTP | 否（仅本机） |
| 3000/3001 | NapCat OneBot HTTP/WS | 否 |
| 7000 | frps 隧道 | 是（建议加 token） |
| 22 | SSH | 是（建议改端口 + 禁密码） |

## 风险

- 2Mbps：首次加载房间要拉多段 webm，慢；必要时素材迁 CDN。
- 2GB 内存：DSH/NapCat/AstrBot 同机容易 OOM，必须 4G swap，观察后决定是否升配。
- QQ 云端登录有风控风险，建议用小号先试。
