# 全屋建模位置缺陷审计（第 3 轮）

日期：2026-11-24  
范围：当前本地预览 `127.0.0.1:5173/room/`；结合无头 Chrome 实景截图、`public/room/world.js` 构件坐标和尺寸复核。此文只记录本轮确认的几何/位置问题，不改模型。

## 确认的问题

| 编号 | 房间 / 构件 | 问题类型 | 严重度 | 确认状态 | 证据与判断 |
|---|---|---|---|---|---|
| A1 | 厨房：冰箱贴、便签、待办纸 | 错位、悬空/贴错面 | 高 | **已修复，截图复核通过** | 原 H3 装饰组在 `x=3.82–4.07, z≈2.06`，离冰箱正面约 2.8m，散落在柜体/地面附近。已移除这组错位的重复装饰，保留原本贴在冰箱正面的便签和磁贴；并将把手深度改为合理的窄条尺寸。见 [修复后冰箱近景](modeling-audit-evidence/fixed-fridge.png)、[修复前截图](modeling-audit-evidence/kitchen-accessories.png)，源码 [world.js:1517](../public/room/world.js#L1517)、[world.js:1524](../public/room/world.js#L1524)。 |
| A2 | 厨房：微波炉 | 离台面悬空、台面支撑不足/大幅悬挑 | 中 | **已修复，截图复核通过** | 微波炉已移到台面中心范围 `(x=3.45,z=0.58)`，底面落在台面顶面 `y=1.005`；0.46×0.34m 的底面完整落在台面范围。见 [修复后厨房近景](modeling-audit-evidence/fixed-kitchen.png)、[修复前截图](modeling-audit-evidence/kitchen-counter.png)，源码 [world.js:1551](../public/room/world.js#L1551)。 |
| A3 | 卫生间：洗手台旁花盆 | 穿模/位置不贴合 | 低 | **已修复，截图复核通过** | 花盆从 `z=7.05` 移到 `z=7.3`，与洗手台柜体后缘留出间距，不再切入柜体。见 [修复后卫生间近景](modeling-audit-evidence/fixed-bathroom.png)、[修复前截图](modeling-audit-evidence/bathroom-top.png)，源码 [world.js:2406](../public/room/world.js#L2406)。 |

## 检查覆盖与结果

已取全屋总览及房间/近景画面，检查厨房、餐厅、客厅、卧室、走廊、家政间、卫生间、阳台、泳池露台、玄关和菜园；菜园另用独立视角检查了种植箱与通道。审计确认三项问题，**三项均已修复并用无头浏览器回看通过**；其余已查看区域未发现足以确认的悬空、穿模、明显错位或歪斜，不把遮挡、透视误差或有意支撑件报成缺陷。

泳池梯池壁上的两个小支座曾在水下视角看起来像悬空块；源码显示它们与两根梯杆同 x 轴、嵌在池壁位置，属于连接支座，本轮**排除**。卧室被褥、窗外远景、泳池露台丰富度等历史问题在上一轮报告中已有修复记录；本轮截图未见相同问题复现。

菜园种植箱、垄槽、通道及棚架已单独俯视检查；未发现可确认的悬空、穿插或偏斜问题。

## 截图

- [全屋总览](modeling-audit-evidence/overview.png)
- [厨房贴件错位](modeling-audit-evidence/kitchen-accessories.png)
- [微波炉与台面](modeling-audit-evidence/kitchen-counter.png)
- [卫生间花盆与洗手台](modeling-audit-evidence/bathroom-top.png)
- [走廊与相邻房间](modeling-audit-evidence/corridor-top.png)
- [家政间](modeling-audit-evidence/laundry-top.png)
- [菜园种植区](modeling-audit-evidence/garden-top.png)
- [修复后冰箱近景](modeling-audit-evidence/fixed-fridge.png)
- [修复后厨房近景](modeling-audit-evidence/fixed-kitchen.png)
- [修复后卫生间近景](modeling-audit-evidence/fixed-bathroom.png)



