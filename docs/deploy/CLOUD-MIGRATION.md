# 迁移到云服务器（Ubuntu 24.04）

服务器：`101.245.76.51`（Ubuntu 24.04，2C2G，40G 盘，2Mbps，100G/月，4G swap）
目标：AstrBot（含 room_link）+ QQ（Snowluma Go 插件）+ dafeiyu-room 整体上云。

## 当前状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| 0 初始化 | ✅ | Node 24.21、4G swap、ufw（22/3100/7000）、nginx |
| 1 AstrBot | ✅ | 4.29.4，systemd 常驻，面板 6185（仅回环，经 SSH 隧道访问） |
| 1.1 room_link 插件 | ✅ | HTTP 6188；能读取云端房间实时状态 |
| 1.2 配置迁移 | ✅ | 3 个 provider、人格、面板账号、`data_v4.db`（17.6MB 对话库）已迁；实测能正常回复 |
| 2 QQ（Snowluma Go） | ✅ | SnowLuma 2.4.2 + QQ 3.2.35（deb），已登录账号 2086213845；OneBot 反向 WS 连到 AstrBot 6199 |
| 3 房间 | ✅ | `http://101.245.76.51:3100/room/` 公网可访问 |
| 3.1 存档迁移 | ✅ | home.json / room.json / garden.json 已迁，历史事件与亲近度保留 |
| 4 验收（QQ→房间） | ✅ | QQ 发「你在房间干嘛」→ 调用 room_status 报云端状态；「跳个舞」/「去厨房」/「去阳台」/「说句话」均已驱动房间 |
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


## 上线后注意事项

- **面板账号**：`astrbot` / 自己改过的密码；面板只监听回环，用 SSH 隧道访问：
  `ssh -N -L 16185:127.0.0.1:6185 root@101.245.76.51` → <http://127.0.0.1:16185>
- **QQ 登录态**：已勾选「自动登录」。若服务器重启后停在快速登录界面，用 VNC 或 xdotool 点一次「登录」：
  `DISPLAY=:99 xdotool mousemove 400 385 click 1`
- **SnowLuma 插件仓库地址**：插件内置的是 `SnowLuma/SnowLuma`（404），已改为 `TomyJan/SnowLuma`；
  插件升级后需重新改 `data/plugins/pulids_snowluma_go_to_astrbot/utils.py` 里的 `GITHUB_API` 与 `SNOWLUMA_RELEASE_BASE`
- **QQ CDN 直链**：服务器/机房 IP 访问 `qqdl.gtimg.cn` 会 403，安装包需先在本地下载再 scp
- **bridge 的 QQ 客户端已关闭**（`snowluma.wsUrl/httpUrl` 置空），QQ 只由 AstrBot 处理，避免两套抢连接
