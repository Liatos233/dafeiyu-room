# 把服务恢复到本机（Windows）

适用于「云端挂了 / 想搬回来」的应急场景。恢复后本机就能跑起房间，QQ 走本机原有的 AstrBot。

## 一键恢复

```powershell
# 在仓库根目录执行
powershell -ExecutionPolicy Bypass -File deploy\local\restore-windows.ps1
```

脚本会：检查 Node → `npm ci` → 解压最近的备份到 `state\` → 启动 bridge。

## 从云端取最新备份

```powershell
powershell -ExecutionPolicy Bypass -File deploy\data\fetch-backup.ps1 -Host 101.245.76.51 -User root
```

备份会下载到 `backups\` 目录（自动取服务器上最新的 `dafeiyu-*.tar.gz`）。

## 恢复指定备份

```powershell
powershell -ExecutionPolicy Bypass -File deploy\local\restore-windows.ps1 -Backup backups\dafeiyu-20261113-013804.tar.gz
```

## 启动 / 停止

```powershell
deploy\local\start-room.bat     # 启动（新窗口）
deploy\local\stop-room.bat      # 停止
```

启动后打开 <http://127.0.0.1:3100/room/>。

## 恢复后需要检查

1. `config.json` 里的 `ownerQQ` / `allow.private` / `allow.groups` 是否正确
2. `room.allowedHosts` 若包含云端 IP，可删掉（本机用不到）
3. `snowluma.wsUrl` / `httpUrl`：本机要连本地 SnowLuma 就填 `ws://127.0.0.1:3001` 与 `http://127.0.0.1:3000`
4. QQ 侧：本机 AstrBot 面板里确认 SnowLuma 已登录
