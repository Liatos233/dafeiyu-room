# 动画场所核对清单（B 方案 · 最终版）

共 269 条，建议修改 **141** 条，保持 128 条，未定 0 条。

分类：at-spot 145 · anywhere 66 · in-place 58

## 规则

- **at-spot**（145 条）：强制走位。吃喝→厨房、睡眠→床/沙发、洗漱→卫生间、工作→书桌、家务→客厅/厨房、玩耍→对应场所
- **anywhere**：就地播，禁止场所 = 卫生间 + 家政间
- **in-place**：情绪/待机/特效，就地

## 调度器必改（2 处）

1. `FREESTYLE_SPOTS` 补 `garden: { room: "garden", spot: "gate" }`
2. `pickFreestyle()`：at-spot 强制 `travel=true`；anywhere 类若在 bathroom/laundry 则重抽

## 一、建议修改

| 片段 | 分组 | 现 spots | 建议 spots | 分类 | 理由 |
|---|---|---|---|---|---|
| 三球抛接 | 玩耍 | living/sofa/pool | living/sofa | at-spot | 室内玩耍在客厅/沙发 |
| 下五子棋 | 玩耍 | sofa | living/sofa | at-spot | 室内玩耍在客厅/沙发 |
| 原地专心玩魔方 | 玩耍 | sofa | living/sofa | at-spot | 室内玩耍在客厅/沙发 |
| 吹气球 | 玩耍 | living/sofa/pool | living/sofa | at-spot | 室内玩耍在客厅/沙发 |
| 抽陀螺 | 玩耍 | living/sofa/pool | living/sofa | at-spot | 室内玩耍在客厅/沙发 |
| 撸猫 | 玩耍 | garden | anywhere | anywhere | 猫不一定在户外，就地 |
| 玩水枪 | 玩耍 | pool | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 玩游戏气急败坏 | 玩耍 | sofa | living/sofa | at-spot | 室内玩耍在客厅/沙发 |
| 荡秋千 | 玩耍 | garden | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 蝴蝶蜜蜂环绕头顶开花 | 玩耍 | garden | anywhere | in-place | 特效，就地 |
| 鲸鱼吐泡泡特效 | 玩耍 | pool | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 吹泡泡 | 玩耍 | pool | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 堆雪人 | 玩耍 | garden | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 打主机游戏 | 玩耍 | sofa | living/sofa | at-spot | 室内玩耍在客厅/沙发 |
| 打雪仗 | 玩耍 | living/sofa/pool | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 拼拼图 | 玩耍 | living/sofa/pool | living/sofa | at-spot | 室内玩耍在客厅/沙发 |
| 搭帐篷 | 玩耍 | living/sofa/pool | living/sofa | at-spot | 室内玩耍在客厅/沙发 |
| 搭积木 | 玩耍 | living/sofa/pool | living/sofa | at-spot | 室内玩耍在客厅/沙发 |
| 放风筝 | 玩耍 | balcony | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 消防员持水枪 | 玩耍 | pool | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 转魔方 | 玩耍 | sofa | living/sofa | at-spot | 室内玩耍在客厅/沙发 |
| 逗狗 | 玩耍 | garden | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 逗猫 | 玩耍 | garden | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 逗蝴蝶 | 玩耍 | garden | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 钓鱼 | 玩耍 | balcony | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 骑木马 | 玩耍 | living/sofa/pool | living/sofa | at-spot | 室内玩耍在客厅/沙发 |
| 东张西望 | 起居 | bed/bathroom/anywhere | anywhere | in-place | 情绪/待机/特效就地 |
| 余额-袋空如洗 | 起居 | bed/bathroom/anywhere | anywhere | in-place | 情绪/待机/特效就地 |
| 原地漂浮踏步 | 起居 | bed/bathroom/anywhere | anywhere | in-place | 情绪/待机/特效就地 |
| 哈欠连天 | 起居 | bed/bathroom/anywhere | bed/sofa | at-spot | 睡眠/躺卧必须在床或沙发 |
| 小幅度原地360度旋转展示 | 起居 | bed/bathroom/anywhere | anywhere | in-place | 情绪/待机/特效就地 |
| 待机呼吸休闲 | 起居 | bed/bathroom/anywhere | anywhere | in-place | 情绪/待机/特效就地 |
| 悠闲哼歌 | 起居 | bed/bathroom/anywhere | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 打瞌睡被惊醒 | 起居 | bed | bed/sofa | at-spot | 睡眠/躺卧必须在床或沙发 |
| 整体换装试色 | 起居 | bed/bathroom/anywhere | bed | at-spot | 换装在卧室 |
| 碎碎念-擦桌碎碎念 | 起居 | bed/bathroom/anywhere | living/kitchen | at-spot | 家务在客厅/厨房，不在床或卫生间 |
| 被鼠标拖拽悬空反馈 | 起居 | bed/bathroom/anywhere | anywhere | in-place | 情绪/待机/特效就地 |
| 超大伸懒腰 | 起居 | bed/bathroom/anywhere | bed/sofa | at-spot | 睡眠/躺卧必须在床或沙发 |
| 剪刘海 | 起居 | bed/bathroom/anywhere | bathroom | at-spot | 洗漱梳妆/排泄必须在卫生间 |
| 叠衣服 | 起居 | bed/bathroom/anywhere | living/kitchen | at-spot | 家务在客厅/厨房，不在床或卫生间 |
| 吸尘器吸地 | 起居 | bed/bathroom/anywhere | living/kitchen | at-spot | 家务在客厅/厨房，不在床或卫生间 |
| 扎马尾 | 起居 | bed/bathroom/anywhere | bathroom/bed | at-spot | 梳妆在卫生间/卧室 |
| 换装侦探服思考 | 起居 | bed/bathroom/anywhere | bed | at-spot | 换装在卧室 |
| 换装浴袍 | 起居 | bed/bathroom/anywhere | bathroom | at-spot | 洗漱梳妆/排泄必须在卫生间 |
| 掏耳朵 | 起居 | bed/bathroom/anywhere | bathroom | at-spot | 洗漱梳妆/排泄必须在卫生间 |
| 擦窗户 | 起居 | bed/bathroom/anywhere | living/kitchen | at-spot | 家务在客厅/厨房，不在床或卫生间 |
| 收拾书桌 | 起居 | desk | living/kitchen | at-spot | 家务在客厅/厨房，不在床或卫生间 |
| 收纳行李箱 | 起居 | bed/bathroom/anywhere | living/kitchen | at-spot | 家务在客厅/厨房，不在床或卫生间 |
| 整理鞋柜 | 起居 | desk | living/kitchen | at-spot | 家务在客厅/厨房，不在床或卫生间 |
| 洗碗 | 起居 | bed/bathroom/anywhere | kitchen | at-spot | 吃喝必须在厨房/餐桌 |
| 熨衣服 | 起居 | bed/bathroom/anywhere | living/kitchen | at-spot | 家务在客厅/厨房，不在床或卫生间 |
| 理发师剪发 | 起居 | bed/bathroom/anywhere | bathroom | at-spot | 洗漱梳妆/排泄必须在卫生间 |
| 站着晃神打瞌睡 | 起居 | bed | bed/sofa | at-spot | 睡眠/躺卧必须在床或沙发 |
| 系围裙 | 起居 | bed/bathroom/anywhere | living/kitchen | at-spot | 家务在客厅/厨房，不在床或卫生间 |
| 踮脚换灯泡 | 起居 | bed/bathroom/anywhere | living/kitchen | at-spot | 家务在客厅/厨房，不在床或卫生间 |
| 铺床单 | 起居 | bed/bathroom/anywhere | living/kitchen | at-spot | 家务在客厅/厨房，不在床或卫生间 |
| 玩手机 | 起居 | sofa | living/sofa | at-spot | 室内玩耍在客厅/沙发 |
| 原地敲击桌面互动 | 吃喝 | kitchen | desk | at-spot | 工作书写必须在书桌 |
| 用鲸鱼尾巴拍打地面 | 吃喝 | kitchen | anywhere | in-place | 搞笑动作，就地 |
| 螃蟹走路 | 吃喝 | kitchen | anywhere | in-place | 搞笑动作，就地 |
| 举糖葫芦 | 吃喝 | living | kitchen | at-spot | 吃喝必须在厨房/餐桌 |
| 吹泡泡糖 | 吃喝 | pool | kitchen | at-spot | 吃喝必须在厨房/餐桌 |
| 蛋糕裱花 | 吃喝 | garden | kitchen | at-spot | 吃喝必须在厨房/餐桌 |
| 优雅女仆舞 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 可爱宅舞 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 吹笛子 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 小提琴演奏 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 扑克魔术 | 才艺 | sofa | anywhere | anywhere | 才艺魔术，除卫生间/家政间外都可 |
| 轻快摇摆舞 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 举哑铃弯举 | 才艺 | living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 交响乐指挥 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 吹长笛 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 唱歌-清唱 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 弹尤克里里 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 弹钢琴 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 打快板 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 拉小提琴 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 拍手鼓 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 指挥合唱 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 摇沙锤 | 才艺 | desk/living | anywhere | anywhere | 才艺乐器 |
| 摇铃铛报喜 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 敲木琴 | 才艺 | desk/living | desk | at-spot | 工作书写必须在书桌 |
| 敲锣打鼓拜年 | 才艺 | desk/living | desk | at-spot | 工作书写必须在书桌 |
| 木匠锯木头 | 才艺 | desk/living | living/kitchen | at-spot | 家务在客厅/厨房，不在床或卫生间 |
| 深蹲举杠铃 | 才艺 | living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 生气鼓腮跺脚 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 织毛衣 | 才艺 | desk/living | living/kitchen | at-spot | 家务在客厅/厨房，不在床或卫生间 |
| 绸带舞 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 缝扣子 | 才艺 | desk/living | living/kitchen | at-spot | 家务在客厅/厨房，不在床或卫生间 |
| 跳芭蕾 | 才艺 | living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 跳街舞 | 才艺 | living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 踢踏舞 | 才艺 | desk/living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 陶艺拉坯 | 才艺 | desk/living | living/kitchen | at-spot | 家务在客厅/厨房，不在床或卫生间 |
| 魔术师变出花 | 才艺 | garden | anywhere | anywhere | 才艺魔术 |
| 凭空生花 | 其它 | garden | anywhere | in-place | 魔法特效，就地 |
| 原地小憩沉眠 | 其它 | anywhere | bed/sofa | at-spot | 睡眠/躺卧必须在床或沙发 |
| 原地跳跃抓碎头顶物品 | 其它 | living | anywhere | in-place | 搞笑动作，就地 |
| 摇扇纳凉 | 其它 | balcony | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 开合跳 | 其它 | living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 拧干湿抹布 | 其它 | anywhere | living/kitchen | at-spot | 家务在客厅/厨房，不在床或卫生间 |
| 挂彩旗 | 其它 | anywhere | living/kitchen | at-spot | 家务在客厅/厨房，不在床或卫生间 |
| 掰巧克力 | 其它 | anywhere | kitchen | at-spot | 食物在厨房 |
| 摘花送镜头 | 其它 | garden | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 撒花瓣 | 其它 | garden | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 放飞纸飞机 | 其它 | anywhere | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 敲木鱼祈福 | 其它 | anywhere | desk | at-spot | 工作书写必须在书桌 |
| 涂口红 | 其它 | anywhere | bathroom | at-spot | 洗漱梳妆/排泄必须在卫生间 |
| 滴眼药水 | 其它 | anywhere | bathroom | at-spot | 洗漱梳妆/排泄必须在卫生间 |
| 熬夜刷手机 | 其它 | sofa | bed/sofa | at-spot | 睡眠/躺卧必须在床或沙发 |
| 看恐怖片捂眼 | 其它 | anywhere | living/sofa | at-spot | 看片在客厅/沙发 |
| 花艺师包花 | 其它 | garden | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 观星指认 | 其它 | balcony | garden/pool/balcony | at-spot | 户外玩耍在菜园/泳池/阳台 |
| 放烟花 | 节日 | garden | anywhere | anywhere | 节日庆祝就地 |
| 放礼花筒 | 节日 | garden | anywhere | anywhere | 节日庆祝就地 |
| 原地左转奔跑 | 运动 | living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 原地蹲下玩玩具汽车 | 运动 | living | living/sofa | at-spot | 室内玩耍在客厅/沙发 |
| 原地重力下蹲压缩 | 运动 | living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 中国功夫 | 运动 | living/pool/garden | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 举杯敬酒 | 运动 | living | kitchen | at-spot | 吃喝必须在厨房/餐桌 |
| 举荧光棒应援 | 运动 | living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 侧身举相机拍别人 | 运动 | living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 保安举金属探测仪 | 运动 | living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 单脚闭眼平衡 | 运动 | living/pool/garden | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 压腿拉伸 | 运动 | living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 原地划桨 | 运动 | living/pool/garden | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 原地打羽毛球 | 运动 | living/pool/garden | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 平板支撑 | 运动 | living/pool/garden | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 打乒乓球 | 运动 | living/pool/garden | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 打太极拳 | 运动 | living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 打滚-原地 | 运动 | living/pool/garden | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 滑雪 | 运动 | living/pool/garden | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 潜水比手势 | 运动 | pool | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 瑜伽树式 | 运动 | living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 被风吹跑帽子 | 运动 | living | anywhere | in-place | 情绪/待机/特效就地 |
| 跳绳-减肥 | 运动 | living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 踢毽子 | 运动 | living/pool/garden | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 转呼啦圈 | 运动 | living | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 游泳 | 运动 | pool | anywhere | anywhere | 才艺/运动就地播（禁止场所：卫生间/家政间） |
| 深度思考碎碎念 | 情绪 | anywhere | desk | at-spot | 工作书写必须在书桌 |
| 被吓一跳 | 情绪 | living | anywhere | in-place | 情绪/待机/特效就地 |
| 狂喜原地跳 | 情绪 | living | anywhere | in-place | 情绪/待机/特效就地 |

## 二、保持原样

| 片段 | 分组 | 现 spots | 分类 |
|---|---|---|---|
| 晨间刷牙 | 起居 | bathroom | at-spot |
| 刷牙 | 起居 | bathroom | at-spot |
| 剪指甲 | 起居 | bathroom | at-spot |
| 梳理鲸鱼尾巴 | 起居 | bathroom | at-spot |
| 洗脸 | 起居 | bathroom | at-spot |
| 中秋赏月吃月饼 | 吃喝 | kitchen | at-spot |
| 偷吃零食被抓住 | 吃喝 | kitchen | at-spot |
| 吃Token | 吃喝 | kitchen | at-spot |
| 吃冰淇淋融化 | 吃喝 | kitchen | at-spot |
| 吃午餐 | 吃喝 | kitchen | at-spot |
| 吃大闸蟹 | 吃喝 | kitchen | at-spot |
| 吃年糕 | 吃喝 | kitchen | at-spot |
| 吃早餐 | 吃喝 | kitchen | at-spot |
| 吃晚餐 | 吃喝 | kitchen | at-spot |
| 吃汤圆 | 吃喝 | kitchen | at-spot |
| 吃白饭 | 吃喝 | kitchen | at-spot |
| 吃粽子 | 吃喝 | kitchen | at-spot |
| 吃糖葫芦 | 吃喝 | kitchen | at-spot |
| 吃腊八粥 | 吃喝 | kitchen | at-spot |
| 吃西瓜 | 吃喝 | kitchen | at-spot |
| 吃重阳糕 | 吃喝 | kitchen | at-spot |
| 吃长寿面 | 吃喝 | kitchen | at-spot |
| 吃青团 | 吃喝 | kitchen | at-spot |
| 吃饺子 | 吃喝 | kitchen | at-spot |
| 大口吃零食 | 吃喝 | kitchen | at-spot |
| 是啊，吃什么 | 吃喝 | kitchen | at-spot |
| 涮火锅 | 吃喝 | kitchen | at-spot |
| 讨糖南瓜灯 | 吃喝 | kitchen | at-spot |
| 冰箱翻吃的 | 吃喝 | kitchen | at-spot |
| 切蛋糕 | 吃喝 | kitchen | at-spot |
| 剥橘子 | 吃喝 | kitchen | at-spot |
| 包饺子 | 吃喝 | kitchen | at-spot |
| 手冲咖啡 | 吃喝 | kitchen | at-spot |
| 手摇磨咖啡 | 吃喝 | kitchen | at-spot |
| 挤番茄酱 | 吃喝 | kitchen | at-spot |
| 捏面人 | 吃喝 | kitchen | at-spot |
| 撒盐调味 | 吃喝 | kitchen | at-spot |
| 擀饺子皮 | 吃喝 | kitchen | at-spot |
| 敷面膜 | 吃喝 | bathroom | at-spot |
| 烤饼干 | 吃喝 | kitchen | at-spot |
| 煮泡面 | 吃喝 | kitchen | at-spot |
| 甩拉面 | 吃喝 | kitchen | at-spot |
| 舔冰淇淋球 | 吃喝 | kitchen | at-spot |
| 雪克杯摇奶茶 | 吃喝 | kitchen | at-spot |
| 写毛笔字 | 才艺 | desk | at-spot |
| 水彩作画 | 才艺 | desk | at-spot |
| 余额-分文不剩 | 其它 | anywhere | in-place |
| 余额-数金皱眉 | 其它 | anywhere | in-place |
| 余额-金袋叮当 | 其它 | anywhere | in-place |
| 余额-钱袋如常 | 其它 | anywhere | in-place |
| 余额-钱袋满溢 | 其它 | anywhere | in-place |
| 动物环绕 | 其它 | anywhere | in-place |
| 变鸽子 | 其它 | anywhere | in-place |
| 女仆屈膝礼仪 | 其它 | anywhere | in-place |
| 照镜子 | 其它 | bathroom | at-spot |
| 萌化小幽灵 | 其它 | anywhere | in-place |
| 蓝鲸现世 | 其它 | anywhere | in-place |
| 被落叶淹没 | 其它 | anywhere | in-place |
| 变戏法撒纸钱 | 其它 | anywhere | in-place |
| 宇航员行走 | 其它 | anywhere | in-place |
| 打嗝不停 | 其它 | anywhere | in-place |
| 打电话汇报 | 其它 | anywhere | in-place |
| 折纸飞机 | 其它 | anywhere | in-place |
| 折纸鹤 | 其它 | anywhere | in-place |
| 拆礼物 | 其它 | anywhere | in-place |
| 画家调色 | 其它 | desk | at-spot |
| 耍流星锤 | 其它 | anywhere | anywhere |
| 脚麻了 | 其它 | anywhere | in-place |
| 衣服标签刺痒 | 其它 | anywhere | in-place |
| 袖口太长 | 其它 | anywhere | in-place |
| 袜子破洞 | 其它 | anywhere | in-place |
| 被阳光晃眼 | 其它 | anywhere | in-place |
| 被雨淋 | 其它 | anywhere | in-place |
| 踩到香蕉皮 | 其它 | anywhere | in-place |
| 踩高跷 | 其它 | anywhere | anywhere |
| 蹦迪-戴墨镜 | 其它 | anywhere | anywhere |
| 递药和水 | 其它 | anywhere | in-place |
| 鞋带松了 | 其它 | anywhere | in-place |
| 风扇前啊啊叫 | 其它 | anywhere | in-place |
| 走路 | 其它 | anywhere | in-place |
| 写代码 | 工作 | desk | at-spot |
| 工作状态-原地踱步张望 | 工作 | desk | at-spot |
| 工作状态-忙碌点按 | 工作 | desk | at-spot |
| 工作状态-清点归档 | 工作 | desk | at-spot |
| 工作状态-雀跃庆祝 | 工作 | desk | at-spot |
| 轻快记录 | 工作 | desk | at-spot |
| 医生听诊 | 工作 | desk | at-spot |
| 厨师抛饼 | 工作 | desk | at-spot |
| 图书管理员嘘 | 工作 | desk | at-spot |
| 工作加班 | 工作 | desk | at-spot |
| 护士量血压 | 工作 | desk | at-spot |
| 摄影师打光 | 工作 | desk | at-spot |
| 服务生托盘 | 工作 | desk | at-spot |
| 检票打孔 | 工作 | desk | at-spot |
| 警察开罚单 | 工作 | desk | at-spot |
| 递包裹 | 工作 | desk | at-spot |
| 量体温 | 工作 | desk | at-spot |
| 钉钉子挂画 | 工作 | desk | at-spot |
| 写福字 | 节日 | desk | at-spot |
| 插茱萸赏菊 | 节日 | anywhere | anywhere |
| 收红包 | 节日 | anywhere | anywhere |
| 放孔明灯 | 节日 | anywhere | anywhere |
| 放河灯 | 节日 | anywhere | anywhere |
| 穿针乞巧 | 节日 | anywhere | anywhere |
| 舞狮头 | 节日 | anywhere | anywhere |
| 装点圣诞树 | 节日 | anywhere | anywhere |
| 挂灯笼 | 节日 | anywhere | anywhere |
| 点许愿灯 | 节日 | anywhere | anywhere |
| 舞狮 | 节日 | anywhere | anywhere |
| 贴春联 | 节日 | anywhere | anywhere |
| 工作状态-垂头叹气冒汗 | 情绪 | desk | at-spot |
| 工作状态-思考冒泡 | 情绪 | desk | at-spot |
| 点击回应-傲娇生气 | 情绪 | anywhere | in-place |
| 点击回应-元气挥手 | 情绪 | anywhere | in-place |
| 点击回应-害羞惊讶 | 情绪 | anywhere | in-place |
| 点击回应-开心跃动 | 情绪 | anywhere | in-place |
| 点击回应-挠痒咯咯笑 | 情绪 | anywhere | in-place |
| 碎碎念-发呆碎碎念 | 情绪 | anywhere | in-place |
| 碎碎念-对屏碎碎念 | 情绪 | anywhere | in-place |
| 害羞捂脸偷看 | 情绪 | anywhere | in-place |
| 尴尬抠手指 | 情绪 | anywhere | in-place |
| 得意炫耀转圈 | 情绪 | anywhere | in-place |
| 心疼捂胸口 | 情绪 | anywhere | in-place |
| 惊讶下巴掉 | 情绪 | anywhere | in-place |
| 感动抹泪 | 情绪 | anywhere | in-place |
| 抖空竹 | 情绪 | anywhere | anywhere |
| 无语扶额 | 情绪 | anywhere | in-place |
| 紧张搓手抖 | 情绪 | anywhere | in-place |
