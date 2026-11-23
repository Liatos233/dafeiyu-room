# 安全与部署约定

> 2026-11-23 做了一轮加固：SSH 只留密钥登录、私钥轮换并加口令、fail2ban、仓库脱敏。
> 这份文档记录**为什么这么做**和**别改回去的地方**，避免以后（人或 AI）顺手把它改回宽松状态。

## 1. SSH：只允许密钥

服务器上的生效配置在 `/etc/ssh/sshd_config.d/00-harden.conf`：

```
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
```

### 为什么文件名必须是 `00-` 开头

`sshd_config` 在第 12 行就 `Include /etc/ssh/sshd_config.d/*.conf`，而 **sshd 对同一个关键字是「先到先得」**——先出现的值生效，后面的静默忽略。

云镜像自带 `/etc/ssh/sshd_config.d/50-cloud-init.conf`，里面有一行 `PasswordAuthentication yes`。所以文件按字典序加载时，我们的必须排在 `50-` 之前才压得住它。用 `99-harden.conf` 会被 `50-` 覆盖（实测过，`sshd -T` 里仍然是 `yes`）。

改完必须做两步校验：

```bash
sshd -t                          # 语法
sshd -T | grep -E '^(passwordauthentication|permitrootlogin|maxauthtries) '
systemctl reload ssh             # 用 reload，不要 restart（reload 不会掐断当前会话）
```

> 改 SSH 配置时**永远保留一个已登录的会话**，另开一个新窗口验证能进，再关旧的。

## 2. fail2ban

`/etc/fail2ban/jail.d/sshd.local`：

```ini
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 <你家出口IP>

[sshd]
enabled = true
backend = systemd
maxretry = 3
findtime = 10m
bantime = 1d
```

### 两个踩过的坑

1. **`ignoreip` 只能写在 `[DEFAULT]` 里**。写在 `[sshd]` 下面不会生效（`fail2ban-client get sshd ignoreip` 会回 "No IP address/network is ignored"），等于没有白名单——3 次失败就会把自己封一天。
2. 家庭宽带出口 IP 会变。变了以后记得更新 `ignoreip`，否则可能把自己关在门外。

检查命令：

```bash
fail2ban-client status sshd
fail2ban-client get sshd ignoreip
```

被封了自己解：`fail2ban-client set sshd unbanip <IP>`。

## 3. 部署私钥

| 项 | 值 |
|---|---|
| 私钥 | `~/.ssh/dafeiyu_cloud_final`（ed25519，**带口令**） |
| 公钥 | 服务器 `/root/.ssh/authorized_keys` 里**只有这一把** |
| 别名 | `~/.ssh/config` 里的 `Host dafeiyu`，可直接 `ssh dafeiyu` |

### 为什么脚本要用 ssh-agent

私钥有口令，而部署脚本是 `BatchMode=yes`（不弹交互提示），所以口令必须由 agent 提供。

首次配置（需要管理员，因为要改服务启动类型）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-ssh-agent.ps1
```

它会把 `ssh-agent` 设为自动启动、启动服务、把密钥加进去。之后每次开机跑一次 `ssh-add` 即可（或再跑一次这个脚本）。

`deploy.ps1` 开头有预检：agent 里没有密钥时直接退出并打印修复命令，**不会**带着缺密钥的状态往后跑。

### 轮换步骤（下一个人接手时照做）

```bash
# 1. 本地生成新钥（在 Git Bash 里跑，PowerShell 传空口令参数会被当成字面量 ""）
ssh-keygen -t ed25519 -a 100 -C "dafeiyu-cloud-<年>" -f ~/.ssh/dafeiyu_cloud_new

# 2. 用旧钥把新公钥追加到服务器，并立刻用新钥验证登录
ssh -i ~/.ssh/dafeiyu_cloud_old dafeiyu "cat >> /root/.ssh/authorized_keys" < ~/.ssh/dafeiyu_cloud_new.pub
ssh -i ~/.ssh/dafeiyu_cloud_new dafeiyu "echo OK"

# 3. 只保留新钥（先备份再覆盖，确认新钥能登之后再做）
cp /root/.ssh/authorized_keys /root/.ssh/authorized_keys.bak
grep -F "$(cat ~/.ssh/dafeiyu_cloud_new.pub)" /root/.ssh/authorized_keys.bak > /root/.ssh/authorized_keys

# 4. 给新钥加口令，本地旧钥销毁
ssh-keygen -p -f ~/.ssh/dafeiyu_cloud_new
shred -u ~/.ssh/dafeiyu_cloud_old
```

顺序不能反：**新钥验证能登之前，不要动旧钥**；动 authorized_keys 之前，先备份。

> 兜底：万一口令丢了、SSH 完全进不去，华为云控制台的 VNC 登录还能用 root 密码进（控制台登录不走 SSH）。

## 4. 部署脚本的地址不再硬编码

仓库里不写服务器 IP。用用户级环境变量：

```powershell
setx DAFEIYU_SERVER <你的服务器IP>
setx DAFEIYU_SSH_KEY %USERPROFILE%\.ssh\dafeiyu_cloud_final   # 可选，默认就是这个
```

注意 `setx` 只对**新开的窗口**生效，已经开着的终端读不到。

截图/冒烟脚本另有两个开关：`DAFEIYU_ROOM_URL`（默认 `http://127.0.0.1:3100/room/`）、`DAFEIYU_ROOT`（输出目录，默认当前目录）。

## 5. 绝对不要提交 / 不要外传的东西

这些都在 `.gitignore` 里，但放错地方一样会泄漏：

| 路径 | 里面有什么 |
|---|---|
| `config.json` | `accessToken` / `authToken` / `apiKey` 真值 |
| `_migrate/` | AstrBot 全量状态备份（含 `cmd_config.json`，里面有 LLM provider 的真实 API Key） |
| `backups/` | 从服务器拉回来的备份 |
| `*.tar.gz` | 同上 |
| `__pycache__/`、`*.pyc` | 会把字符串常量（含 QQ 号）带进仓库 |

**迁移包是最容易出事的一类**：`_migrate/astrbot-full-state.tar.gz` 里就是一份完整配置，随手传网盘或发人就等于交出所有密钥。需要分享状态时，先按第 6 节清一遍。

## 6. 提交前自查

```bash
# 私钥、云厂商 key、明文令牌
git grep -n -I -E "BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9_-]{16,}|ghp_|AKIA|AIza"

# 服务器 IP / QQ 号 / 本机用户名
git grep -n -I -E "[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|[A-Za-z]:\\\\?Users\\\\?"
```

文档和示例里一律写占位符：`<your-server-ip>`、`<owner-qq>`、`<repo>`、`%USERPROFILE%`。

## 7. 回滚

改坏了 / 要临时恢复密码登录（不推荐）：

```bash
cp /etc/ssh/sshd_config.bak.20261123 /etc/ssh/sshd_config   # 仅还原主配置
mv /etc/ssh/sshd_config.d/00-harden.conf /root/00-harden.conf.disabled
sshd -t && systemctl reload ssh
```

fail2ban 临时停：`systemctl stop fail2ban`（建议只 `bantime` 调小，别停服务）。

## 8. 还欠着的事

- [ ] GitHub 上的**历史提交**里仍有服务器 IP 和 QQ 号（已公开 9 天）。要彻底抹掉需要 `git filter-repo` + force push，收益有限，未做。
- [ ] 服务器只保留了 22 端口。更彻底的做法是在云安全组里只放行家庭出口 IP，或把 SSH 换到非常用端口。
- [ ] `_migrate/cmd_config.json` 里的硅基流动 API Key 是否需要轮换（取决于是否还在用）。
