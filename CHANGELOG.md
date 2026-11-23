# 版本记录

版本号以 `package.json` 的 `version` 为准（当前 `2.0.0`）。  
旧版用「大肥鱼房子最新版 N + zip 包」的方式分发，那套约定已经废弃，改成按语义化版本走。

## Unreleased

### 文档
- 重写 `README.md`，按当前仓库实际情况写：项目定位与架构图、269 段动作（9 组）、8 畦 12 作物、`/api/home` 六个接口、与上游的真实差异表；AstrBot 插件拆成「随仓库分发」和「第三方参考」两栏
- 新增 `docs/SECURITY.md`：SSH 只留密钥、fail2ban、私钥轮换步骤、不可外传目录清单、提交前自查命令
- `SETUP.md` / `GITHUB_UPLOAD.md` 里的旧目录名 `dsh-room-template` 改为 `dafeiyu-room`

### 安全
- 服务器：`PasswordAuthentication no`、`PermitRootLogin prohibit-password`、`MaxAuthTries 3`，装机自带的 `50-cloud-init.conf` 会覆盖同名配置，加固文件必须命名为 `00-harden.conf`
- fail2ban：`sshd` jail，3 次失败封 1 天；`ignoreip` 只能写在 `[DEFAULT]`
- 部署私钥轮换为带口令的 ed25519，旧钥从服务器与本机一并移除；部署脚本改为依赖 `ssh-agent`，并在执行前检查
- 仓库脱敏：插件 `owner_qq` 不再内置真实 QQ 号；服务器地址改 `DAFEIYU_SERVER` 环境变量；脚本里的本机绝对路径改 `$env:USERPROFILE`；文档里的 IP / QQ / B 站号换成占位符
- `.gitignore` 增加 `__pycache__/`、`*.pyc`

### 其它
- 修正 package 名 `dafiyu-house-template` → `dafeiyu-room`（`package-lock.json` 同步）
- 删除 `VERSION.txt`、`START_HERE.txt`：属于 zip 分发流程的遗留物，内容与 README/SETUP 重复，其中写的端口 13100 也是错的（实际房间与控制台同一端口，默认 3100）

## 2.0.0

原「大肥鱼房子最新版 2」。

- 清理根目录重复模型（58.9 MB）
- 删除未引用的 examples 图片和 `garden-showcase.html`
- 清理 `src/bridge.js` 中的真实 QQ、本机路径和默认私人角色名
- 修复 README 的占位仓库链接
- 拆分标准 MIT LICENSE 与第三方说明
- 统一 package 身份和版本号
- 功能保持不变

## 1.0.0

原「大肥鱼房子最新版 1」。

- 完整 3D 房间、菜园、电视、陪伴层和 QQ 桥接
- 6.7 MB 优化模型 + 58.9 MB 原始工程模型
- 3D 标准 / 高画质切换
- 最新走路动画、动作栏、菜园拖拽
- SnowLuma / NapCat 双网关支持
- 安装文档、NapCat 文档、新手 GitHub 教程
