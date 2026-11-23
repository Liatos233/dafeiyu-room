# 第三方素材与依赖

## 上游项目

- **仓库**：<https://github.com/sh2234113/feiyu-room-template>（作者 sh2234113）
- **关系**：本仓库 fork 自上游「大肥鱼房子模板」，并在其基础上继续开发
- **上游许可**：代码 MIT；2D 立绘与动作素材 CC BY-NC-SA 4.0
- **保留义务**：沿用上游的署名要求，保留本文件与 `public/room/assets/pet/CREDITS.md`，不得商业使用上游素材

## 代码

本项目代码：MIT，见 `LICENSE`。

## 2D 立绘 / 动画

- 来源：**dsh-pet** <https://github.com/PC2005-cloud/dsh-pet>
- 内容：`public/room/assets/pet/*.webm`、`*.png`、`public/room/assets/sound/click-duck.wav`
- 授权：**CC BY-NC-SA 4.0**
- 约束：署名、非商业、相同方式共享
- 详细署名：`public/room/assets/pet/CREDITS.md`

## 动作素材（pet-import / pet-gen）

- **精灵图素材源**：**aboutme-pets** <https://github.com/hunmer/aboutme-pets>
  - `scripts/download_pet_sheets.py` 从该仓库拉取 `pets/dsh`、`pets/dsh1` 两个动作包的精灵图；
    `scripts/gen_pet_sheets.py` 再转成项目使用的动作元数据与 WebM。
  - 该仓库的要求：**禁止商用**；二次创作需署名其上游形象来源 `PC2005-cloud/dsh-pet`。
  - 运行期生成的 `public/room/assets/pet-sheets/` 不入库（由脚本按需下载）。
- `public/room/assets/pet-import/*.webm`：由 aboutme-pets 精灵图转码而来，形象源自 dsh-pet，授权 **CC BY-NC-SA 4.0**
- `public/room/assets/pet-gen/*.webm`：由同一批精灵图逐帧转码，授权同上
- `public/room/assets/pet-gen/swim.webm`、`phone.webm`：作者用 AI 视频生成 + ffmpeg 绿幕抠像制作，角色形象源自 dsh-pet，按 **CC BY-NC-SA 4.0** 共享
- 署名要求：**同时标注 aboutme-pets（精灵图源）与 dsh-pet（形象源）**、保留本文件、不得商业使用、修改后需相同方式共享

> 注：本文件早期版本只署名了 dsh-pet，遗漏了 aboutme-pets；2026-11-22 补齐。

## 3D 模型（源自上游仓库）

- 文件：`public/room/assets/models/da-feiyu.opt.glb`（7,021,424 字节 ≈ 6.7 MB，页面加载）
- 文件：`public/room/assets/models/da-feiyu.glb`（58,885,308 字节 ≈ 58.9 MB，原始工程，页面不加载）
- 来源：**上游仓库** <https://github.com/sh2234113/feiyu-room-template> 的作者提供（Tripo 生成后减面/优化）。
  本仓库随代码一并分发，两个文件与上游**字节一致**（blob `91000f63ccdf1af8268c67ac5767775b84cff868` / `6637c5c03648caa33187233181089882c94dbc83`）。
- 授权：版权归**上游作者**；随本模板用于个人、非商业展示
- 限制：不可单独提取、转售、商用或批量再分发；商用/二次创作需上游作者许可

## Three.js

- `public/room/vendor/three.module.js`
- 授权：MIT
- 许可证文本：`public/room/vendor/LICENSE-three.txt`

## 运行依赖

见 `package.json`：

- `@deepseek-ai/dsh-host-apiproxy`
- `@deepseek-ai/schemastery`
- `@modelcontextprotocol/sdk`
- `@snowluma/mcp`
- `@snowluma/sdk`
- `js-yaml`
- `zod`

各自遵循其上游许可证。`@snowluma/*` 是第三方 SDK，本仓库不重新授权它。

## SnowLuma

SnowLuma 是独立软件，**不在本仓库内，也不随本仓库分发**。  
使用前请自行确认其许可证和 QQ 平台规则。

## 未包含

- 作者角色卡、语音、照片、聊天记录；
- 任何 API Key、Cookie、token。
