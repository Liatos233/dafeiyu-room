# 迁移到云服务器（Ubuntu 24.04）

服务器：`101.245.76.51`（Ubuntu 24.04，2C2G，40G 盘，2Mbps，100G/月，4G swap）
目标：AstrBot（含 room_link）+ QQ（Snowluma Go 插件）+ dafeiyu-room 整体上云。

## 当前状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| 0 初始化 | ✅ | Node 24.21、4G swap、ufw（22/3100/7000）、nginx |
| 1 AstrBot | ✅ | 4.29.4，systemd 常驻，面板 6185（仅回环，经 SSH 隧道访问） |
| 1.1 room_link 插件 | ✅ | HTTP 6188；能读取云端房间实时状态 |
| 1.2 配置迁移 | ✅ | 3 个 provider、人格、面板账号已迁；实测能正常回复 |
| 2 QQ（Snowluma Go） | ⏳ | 插件已加载，**等待在面板里安装 SnowLuma 并扫码登录** |
| 3 房间 | ✅ | `http://101.245.76.51:3100/room/` 公网可访问 |
| 3.1 存档迁移 | ✅ | home.json / room.json / garden.json 已迁，历史事件与亲近度保留 |
| 4 验收（QQ→房间） | ⏳ | 等 QQ 登录后验证 |
| 5 systemd 常驻 | ✅ | `dafeiyu-room`、`astrbot`、`nginx` 全部 active + 自启 |
| 5.1 备份 | ✅ | 每日 04:00 打包房间状态 + AstrBot 配置/数据库到 `/var/backups/dafeiyu`，保留 7 份 |
| 6 DSH 上云 | 暂不需要 | QQ 与人格由 AstrBot 负责，房间只做状态/表现 |

## 架构

```
手机/浏览器 ──> 101.245.76.51:3100 (nginx)
                     └─> 127.0.0.1:3101  bridge（房间状态 + API + 静态站）

AstrBot(6185 面板 / 6188 插件 HTTP)
   ├─ pulids_snowluma_go_to_astrbot ── SnowLuma ── QQ 账号
   └─ astrbot_plugin_room_link ──> http://127.0.0.1:3101/api/*  （读状态、下指令）
```

## 端口

| 端口 | 用途 | 对外 |
|---|---|---|
| 3100 | 房间（nginx → bridge 3101） | 是 |
| 6185 | AstrBot 面板 | 否（SSH 隧道 `-L 16185:127.0.0.1:6185`） |
| 6188 | room_link 插件 HTTP | 否（仅本机） |
| 3000/3001 | SnowLuma OneBot（装好后） | 否 |

## 关键配置

`/opt/dafeiyu-room/config.json`

```json
{
  "consolePort": 3101,
  "room": { "access": "loopback", "allowedHosts": ["101.245.76.51:3100"] },
  "astrbot": { "baseUrl": "http://127.0.0.1:6188" }
}
```

`/root/data/config/astrbot_plugin_room_link_config.json`

```json
{
  "bridge_dir": "/opt/dafeiyu-room",
  "bridge_node": "/usr/bin/node",
  "bridge_port": 3101,
  "bridge_auto_start": false,
  "listen_host": "127.0.0.1"
}
```

## 常用命令

```bash
systemctl status dafeiyu-room astrbot nginx
journalctl -u astrbot -n 50 --no-pager
tail -f /var/log/dafeiyu-room.log
bash /usr/local/bin/dafeiyu-backup.sh      # 手动备份
ls -lh /var/backups/dafeiyu
```

## 踩坑记录

| 现象 | 原因 | 处理 |
|---|---|---|
| SSH `Permission denied (publickey)` | `ssh-keygen -N '""'` 把引号当成了口令 | `ssh-keygen -p -P '""' -N ''` 解除 |
| 房间页卡在加载屏 | `app.js` 是 ES module，带 `Origin` 头，bridge 只认回环 Host | bridge 支持 `room.allowedHosts`；nginx `proxy_set_header Origin ""` |
| bridge 403 | nginx 转发 `Host: 127.0.0.1`（无端口） | nginx 固定 `Host: 127.0.0.1:3101` |
| `astrbot run` 报 `/root is not a valid root` | 需要先初始化 | `astrbot init -y` |
| service `status=209/STDOUT` | 日志目录不存在 | `mkdir -p /root/data/logs` |
| pip 安装极慢 | 默认 PyPI | 换清华镜像 |
