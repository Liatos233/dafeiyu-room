# deploy/ — 部署与灾备

两套目标：**云服务器**（长期在线）和 **本机**（灾备 / 随时搬回来）。

```
deploy/
├── cloud/            云服务器一键部署
│   ├── install.sh        主入口（含 nginx / systemd / 备份）
│   ├── 10-bootstrap.sh   Node 24 / swap / ufw
│   ├── 20-astrbot.sh     AstrBot + room_link + Snowluma Go + QQ 依赖
│   ├── backup.sh         每日备份脚本
│   ├── nginx-room.conf   3100 → 3101 反代
│   └── units/            systemd 单元
├── local/            本机恢复
│   ├── restore-windows.ps1
│   ├── start-room.bat / stop-room.bat
│   └── README.md
├── data/             备份搬运与恢复
│   ├── fetch-backup.ps1     本机 ← 云端（scp 最新备份）
│   └── restore-backup.sh    云端内恢复
└── plugins/astrbot_plugin_room_link/   随仓库分发的插件
```

## 一、新服务器一键部署

```bash
# 只验证「拉代码 + 数据保留」，不装依赖/不改服务
bash /opt/src/deploy/cloud/install.sh --dry-run

# 以 root 登录新服务器后
git clone https://github.com/Liatos233/dafeiyu-room.git /opt/src
bash /opt/src/deploy/cloud/install.sh --with-astrbot
```

脚本会依次完成：

1. Node 24 + 4G swap + ufw（22/3100）
2. 拉代码到 `/opt/dafeiyu-room` + `npm ci`
3. 生成 `config.json`（`consolePort=3101`、`allowedHosts=<公网IP>:3100`）
4. `dafeiyu-room.service` 常驻
5. nginx 反代 3100 → 3101
6. 每日备份 timer
7. （可选）AstrBot + room_link + Snowluma Go + Xvfb/x11vnc + QQ 依赖

**需要手工的两步**：

- `config.json` 里填 `ownerQQ`、`allow.private`、`allow.groups`
- QQ 本体 deb 需先放到 `/root/QQ.deb`（腾讯 CDN 对机房 IP 403，脚本无法直连）

## 二、把服务搬回本机

```powershell
# 1) 取云端最新备份
powershell -ExecutionPolicy Bypass -File deploy\data\fetch-backup.ps1

# 2) 恢复并启动
powershell -ExecutionPolicy Bypass -File deploy\local\restore-windows.ps1 -Backup backups\dafeiyu-xxxx.tar.gz
```

恢复后房间在 <http://127.0.0.1:3100/room/>。
本机 AstrBot（launcher 里那个）用自己原有的配置，不受影响；备份里的 AstrBot 数据是给你手动覆盖用的。

## 三、备份与恢复

| 动作 | 命令 |
|---|---|
| 云端立即备份 | `bash /usr/local/bin/dafeiyu-backup.sh` |
| 云端查看备份 | `ls -lh /var/backups/dafeiyu` |
| 云端恢复最新 | `bash deploy/data/restore-backup.sh` |
| 拉到本机 | `deploy\data\fetch-backup.ps1` |
| 本机恢复 | `deploy\local\restore-windows.ps1 -Backup <tar.gz>` |

备份内容：`state/`（房间、菜园、记忆卡）+ `cmd_config.json` + `data_v4.db` + 插件配置/数据；保留最近 7 份。

## 四、切换回云端

云端恢复后把 QQ 重新登录（SnowLuma 面板 → 启动 → 扫码/快速登录），本机 bridge 关掉即可：

```powershell
deploy\local\stop-room.bat
```

## 五、已知限制

- **QQ 重启后可能停在快速登录页**：`DISPLAY=:99 xdotool mousemove 400 385 click 1`
- **2Mbps 带宽**：素材多，外网首次加载慢；量大时把 `public/room/assets` 迁 CDN
- **QQ 账号有风控风险**，建议用小号




## 六、日常更新（服务器上）

```bash
# 只更新房间（代码 + 依赖 + 重启，自动先备份）
bash /usr/local/bin/update.sh          # 或 /opt/dafeiyu-room/deploy/cloud/update.sh

# 连 AstrBot 一起更新
bash /usr/local/bin/update.sh --astrbot

# 更新房间 + 同步插件包
bash /usr/local/bin/update.sh --plugins /root/astrbot-plugins.tar.gz
```

`update.sh` 流程：备份 → `git reset --hard origin/main` → `npm ci` → 重启并自检；
`state/`、`config.json` 不会被覆盖。

## 七、插件同步（本地 → 云端）

本地打包（只打包插件目录 + 配置，不含 `__pycache__`）：

```bash
# 在仓库根目录
python scripts/pack-astrbot-plugins.py      # 产物：_migrate/astrbot-plugins.tar.gz
scp _migrate/astrbot-plugins.tar.gz root@<服务器>:/root/
```

云端安装：

```bash
bash /usr/local/bin/sync-plugins.sh /root/astrbot-plugins.tar.gz
# 不覆盖云端已有配置：FORCE_CONFIG=0 bash ...
```

`sync-plugins.sh` 会：停 AstrBot → 覆盖插件目录 → 复制配置 → 逐个插件 `pip install -r requirements.txt` → 启动 → 打印加载结果 → 自检 room_link。

当前云端已同步的插件（13 个）：

```
room_link / snowluma_go / group_chat_plus / livingmemory / memewiki /
proactive_chat / qqprofile / qzone / seed_audio_tts / meme_manager /
bili_whale / dafeiyu_clean / dafeiyu_signature / dafeiyu_sing
```

> 内存注意：全量插件下 AstrBot 占用约 1.1 GB（2 GB 机器 + 4G swap 可跑）。
> 如果频繁 OOM，优先停 `livingmemory` / `meme_manager`（两者都带 faiss 索引）。
