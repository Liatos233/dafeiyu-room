// 小蓝鱼的立绘播放器 —— dsh-pet 的透明 webm 动画贴在 3D 画面上。
//
// 只做表现：切片段、交叉淡入、脚下阴影、朝向相机。行为由 home-state.js 决定。
import * as THREE from './vendor/three.module.js';

// 有些原始走路片段开头是站立/起步前摇。循环时从 trim 点开始，
// 避免角色已经在移动、画面却还站着滑一段。
// run_happy.webm 已用 ffmpeg 物理裁掉起势（assets/pet/run_happy.orig.webm 是原文件），
// 这里不再需要运行时裁剪。
const LOOP_TRIM = Object.freeze({});

// ── 补充动作：官方 webm（pet-import）+ 精灵图转出（pet-gen）──────────
export const GEN_CLIPS = Object.freeze({
  '三球抛接': 'assets/pet-import/三球抛接.webm',
  '下五子棋': 'assets/pet-import/下五子棋.webm',
  '东张西望': 'assets/pet-import/东张西望.webm',
  '中秋赏月吃月饼': 'assets/pet-import/中秋赏月吃月饼.webm',
  '优雅女仆舞': 'assets/pet-import/优雅女仆舞.webm',
  '余额-分文不剩': 'assets/pet-import/余额-分文不剩.webm',
  '余额-数金皱眉': 'assets/pet-import/余额-数金皱眉.webm',
  '余额-袋空如洗': 'assets/pet-import/余额-袋空如洗.webm',
  '余额-金袋叮当': 'assets/pet-import/余额-金袋叮当.webm',
  '余额-钱袋如常': 'assets/pet-import/余额-钱袋如常.webm',
  '余额-钱袋满溢': 'assets/pet-import/余额-钱袋满溢.webm',
  '侧身急躁跑': 'assets/pet-import/侧身急躁跑.webm',
  '偷吃零食被抓住': 'assets/pet-import/偷吃零食被抓住.webm',
  '写代码': 'assets/pet-import/写代码.webm',
  '写福字': 'assets/pet-import/写福字.webm',
  '凭空生花': 'assets/pet-import/凭空生花.webm',
  '动物环绕': 'assets/pet-import/动物环绕.webm',
  '原地专心玩魔方': 'assets/pet-import/原地专心玩魔方.webm',
  '原地小憩沉眠': 'assets/pet-import/原地小憩沉眠.webm',
  '原地左转奔跑': 'assets/pet-import/原地左转奔跑.webm',
  '原地敲击桌面互动': 'assets/pet-import/原地敲击桌面互动.webm',
  '原地漂浮踏步': 'assets/pet-import/原地漂浮踏步.webm',
  '原地跳跃抓碎头顶物品': 'assets/pet-import/原地跳跃抓碎头顶物品.webm',
  '原地蹲下玩玩具汽车': 'assets/pet-import/原地蹲下玩玩具汽车.webm',
  '原地重力下蹲压缩': 'assets/pet-import/原地重力下蹲压缩.webm',
  '变鸽子': 'assets/pet-import/变鸽子.webm',
  '可爱宅舞': 'assets/pet-import/可爱宅舞.webm',
  '吃Token': 'assets/pet-import/吃Token.webm',
  '吃冰淇淋融化': 'assets/pet-import/吃冰淇淋融化.webm',
  '吃午餐': 'assets/pet-import/吃午餐.webm',
  '吃大闸蟹': 'assets/pet-import/吃大闸蟹.webm',
  '吃年糕': 'assets/pet-import/吃年糕.webm',
  '吃早餐': 'assets/pet-import/吃早餐.webm',
  '吃晚餐': 'assets/pet-import/吃晚餐.webm',
  '吃汤圆': 'assets/pet-import/吃汤圆.webm',
  '吃白饭': 'assets/pet-import/吃白饭.webm',
  '吃粽子': 'assets/pet-import/吃粽子.webm',
  '吃糖葫芦': 'assets/pet-import/吃糖葫芦.webm',
  '吃腊八粥': 'assets/pet-import/吃腊八粥.webm',
  '吃西瓜': 'assets/pet-import/吃西瓜.webm',
  '吃重阳糕': 'assets/pet-import/吃重阳糕.webm',
  '吃长寿面': 'assets/pet-import/吃长寿面.webm',
  '吃青团': 'assets/pet-import/吃青团.webm',
  '吃饭·碗饭': 'assets/pet-import/吃饭·碗饭.webm',
  '吃饭团': 'assets/pet-import/吃饭团.webm',
  '吃饺子': 'assets/pet-import/吃饺子.webm',
  '吹气球': 'assets/pet-import/吹气球.webm',
  '吹笛子': 'assets/pet-import/吹笛子.webm',
  '哈欠连天': 'assets/pet-import/哈欠连天.webm',
  '堆雪人': 'assets/pet-import/堆雪人.webm',
  '大口吃零食': 'assets/pet-import/大口吃零食.webm',
  '女仆屈膝礼仪': 'assets/pet-import/女仆屈膝礼仪.webm',
  '小幅度原地360度旋转展示': 'assets/pet-import/小幅度原地360度旋转展示.webm',
  '小提琴演奏': 'assets/pet-import/小提琴演奏.webm',
  '工作状态-原地踱步张望': 'assets/pet-import/工作状态-原地踱步张望.webm',
  '工作状态-垂头叹气冒汗': 'assets/pet-import/工作状态-垂头叹气冒汗.webm',
  '工作状态-忙碌点按': 'assets/pet-import/工作状态-忙碌点按.webm',
  '工作状态-思考冒泡': 'assets/pet-import/工作状态-思考冒泡.webm',
  '工作状态-清点归档': 'assets/pet-import/工作状态-清点归档.webm',
  '工作状态-雀跃庆祝': 'assets/pet-import/工作状态-雀跃庆祝.webm',
  '开心小跑': 'assets/pet-import/开心小跑.webm',
  '待机呼吸休闲': 'assets/pet-import/待机呼吸休闲.webm',
  '悠闲哼歌': 'assets/pet-import/悠闲哼歌.webm',
  '扑克魔术': 'assets/pet-import/扑克魔术.webm',
  '打瞌睡被惊醒': 'assets/pet-import/打瞌睡被惊醒.webm',
  '抽陀螺': 'assets/pet-import/抽陀螺.webm',
  '拆礼物': 'assets/pet-import/拆礼物.webm',
  '插茱萸赏菊': 'assets/pet-import/插茱萸赏菊.webm',
  '摇扇纳凉': 'assets/pet-import/摇扇纳凉.webm',
  '撸猫': 'assets/pet-import/撸猫.webm',
  '收红包': 'assets/pet-import/收红包.webm',
  '放孔明灯': 'assets/pet-import/放孔明灯.webm',
  '放河灯': 'assets/pet-import/放河灯.webm',
  '放烟花': 'assets/pet-import/放烟花.webm',
  '放风筝': 'assets/pet-import/放风筝.webm',
  '整体换装试色': 'assets/pet-import/整体换装试色.webm',
  '是啊，吃什么': 'assets/pet-import/是啊，吃什么.webm',
  '晨间刷牙': 'assets/pet-import/晨间刷牙.webm',
  '期待开饭': 'assets/pet-import/期待开饭.webm',
  '涮火锅': 'assets/pet-import/涮火锅.webm',
  '深度思考碎碎念': 'assets/pet-import/深度思考碎碎念.webm',
  '点击回应-傲娇生气': 'assets/pet-import/点击回应-傲娇生气.webm',
  '点击回应-元气挥手': 'assets/pet-import/点击回应-元气挥手.webm',
  '点击回应-害羞惊讶': 'assets/pet-import/点击回应-害羞惊讶.webm',
  '点击回应-开心跃动': 'assets/pet-import/点击回应-开心跃动.webm',
  '点击回应-挠痒咯咯笑': 'assets/pet-import/点击回应-挠痒咯咯笑.webm',
  '照镜子': 'assets/pet-import/照镜子.webm',
  '玩水枪': 'assets/pet-import/玩水枪.webm',
  '玩游戏气急败坏': 'assets/pet-import/玩游戏气急败坏.webm',
  '用鲸鱼尾巴拍打地面': 'assets/pet-import/用鲸鱼尾巴拍打地面.webm',
  '睡觉-开始': 'assets/pet-import/睡觉-开始.webm',
  '睡觉-循环': 'assets/pet-import/睡觉-循环.webm',
  '睡觉-起来': 'assets/pet-import/睡觉-起来.webm',
  '碎碎念-发呆碎碎念': 'assets/pet-import/碎碎念-发呆碎碎念.webm',
  '碎碎念-对屏碎碎念': 'assets/pet-import/碎碎念-对屏碎碎念.webm',
  '碎碎念-擦桌碎碎念': 'assets/pet-import/碎碎念-擦桌碎碎念.webm',
  '穿针乞巧': 'assets/pet-import/穿针乞巧.webm',
  '舞狮头': 'assets/pet-import/舞狮头.webm',
  '荡秋千': 'assets/pet-import/荡秋千.webm',
  '萌化小幽灵': 'assets/pet-import/萌化小幽灵.webm',
  '蓝鲸现世': 'assets/pet-import/蓝鲸现世.webm',
  '蝴蝶蜜蜂环绕头顶开花': 'assets/pet-import/蝴蝶蜜蜂环绕头顶开花.webm',
  '螃蟹走路': 'assets/pet-import/螃蟹走路.webm',
  '被吓一跳': 'assets/pet-import/被吓一跳.webm',
  '被落叶淹没': 'assets/pet-import/被落叶淹没.webm',
  '被鼠标拖拽悬空反馈': 'assets/pet-import/被鼠标拖拽悬空反馈.webm',
  '装点圣诞树': 'assets/pet-import/装点圣诞树.webm',
  '讨糖南瓜灯': 'assets/pet-import/讨糖南瓜灯.webm',
  '超大伸懒腰': 'assets/pet-import/超大伸懒腰.webm',
  '踢毽子': 'assets/pet-import/踢毽子.webm',
  '轻快摇摆舞': 'assets/pet-import/轻快摇摆舞.webm',
  '轻快记录': 'assets/pet-import/轻快记录.webm',
  '骑木马': 'assets/pet-import/骑木马.webm',
  '鲸鱼吐泡泡特效': 'assets/pet-import/鲸鱼吐泡泡特效.webm',
  '中国功夫': 'assets/pet-gen/中国功夫.webm',
  '举哑铃弯举': 'assets/pet-gen/举哑铃弯举.webm',
  '举杯敬酒': 'assets/pet-gen/举杯敬酒.webm',
  '举糖葫芦': 'assets/pet-gen/举糖葫芦.webm',
  '举荧光棒应援': 'assets/pet-gen/举荧光棒应援.webm',
  '交响乐指挥': 'assets/pet-gen/交响乐指挥.webm',
  '侧身举相机拍别人': 'assets/pet-gen/侧身举相机拍别人.webm',
  '保安举金属探测仪': 'assets/pet-gen/保安举金属探测仪.webm',
  '写毛笔字': 'assets/pet-gen/写毛笔字.webm',
  '冰箱翻吃的': 'assets/pet-gen/冰箱翻吃的.webm',
  '切蛋糕': 'assets/pet-gen/切蛋糕.webm',
  '刷牙': 'assets/pet-gen/刷牙.webm',
  '剥橘子': 'assets/pet-gen/剥橘子.webm',
  '剪刘海': 'assets/pet-gen/剪刘海.webm',
  '剪指甲': 'assets/pet-gen/剪指甲.webm',
  '包饺子': 'assets/pet-gen/包饺子.webm',
  '医生听诊': 'assets/pet-gen/医生听诊.webm',
  '单脚闭眼平衡': 'assets/pet-gen/单脚闭眼平衡.webm',
  '压腿拉伸': 'assets/pet-gen/压腿拉伸.webm',
  '原地划桨': 'assets/pet-gen/原地划桨.webm',
  '原地打羽毛球': 'assets/pet-gen/原地打羽毛球.webm',
  '厨师抛饼': 'assets/pet-gen/厨师抛饼.webm',
  '变戏法撒纸钱': 'assets/pet-gen/变戏法撒纸钱.webm',
  '叠衣服': 'assets/pet-gen/叠衣服.webm',
  '吸尘器吸地': 'assets/pet-gen/吸尘器吸地.webm',
  '吹泡泡': 'assets/pet-gen/吹泡泡.webm',
  '吹泡泡糖': 'assets/pet-gen/吹泡泡糖.webm',
  '吹长笛': 'assets/pet-gen/吹长笛.webm',
  '唱歌-清唱': 'assets/pet-gen/唱歌-清唱.webm',
  '图书管理员嘘': 'assets/pet-gen/图书管理员嘘.webm',
  '宇航员行走': 'assets/pet-gen/宇航员行走.webm',
  '害羞捂脸偷看': 'assets/pet-gen/害羞捂脸偷看.webm',
  '尴尬抠手指': 'assets/pet-gen/尴尬抠手指.webm',
  '工作加班': 'assets/pet-gen/工作加班.webm',
  '平板支撑': 'assets/pet-gen/平板支撑.webm',
  '开合跳': 'assets/pet-gen/开合跳.webm',
  '弹尤克里里': 'assets/pet-gen/弹尤克里里.webm',
  '弹钢琴': 'assets/pet-gen/弹钢琴.webm',
  '得意炫耀转圈': 'assets/pet-gen/得意炫耀转圈.webm',
  '心疼捂胸口': 'assets/pet-gen/心疼捂胸口.webm',
  '惊讶下巴掉': 'assets/pet-gen/惊讶下巴掉.webm',
  '感动抹泪': 'assets/pet-gen/感动抹泪.webm',
  '手冲咖啡': 'assets/pet-gen/手冲咖啡.webm',
  '手摇磨咖啡': 'assets/pet-gen/手摇磨咖啡.webm',
  '扎马尾': 'assets/pet-gen/扎马尾.webm',
  '打主机游戏': 'assets/pet-gen/打主机游戏.webm',
  '打乒乓球': 'assets/pet-gen/打乒乓球.webm',
  '打嗝不停': 'assets/pet-gen/打嗝不停.webm',
  '打太极拳': 'assets/pet-gen/打太极拳.webm',
  '打快板': 'assets/pet-gen/打快板.webm',
  '打滚-原地': 'assets/pet-gen/打滚-原地.webm',
  '打电话汇报': 'assets/pet-gen/打电话汇报.webm',
  '打雪仗': 'assets/pet-gen/打雪仗.webm',
  '抖空竹': 'assets/pet-gen/抖空竹.webm',
  '折纸飞机': 'assets/pet-gen/折纸飞机.webm',
  '折纸鹤': 'assets/pet-gen/折纸鹤.webm',
  '护士量血压': 'assets/pet-gen/护士量血压.webm',
  '拉小提琴': 'assets/pet-gen/拉小提琴.webm',
  '拍手鼓': 'assets/pet-gen/拍手鼓.webm',
  '拧干湿抹布': 'assets/pet-gen/拧干湿抹布.webm',
  '拼拼图': 'assets/pet-gen/拼拼图.webm',
  '挂彩旗': 'assets/pet-gen/挂彩旗.webm',
  '挂灯笼': 'assets/pet-gen/挂灯笼.webm',
  '指挥合唱': 'assets/pet-gen/指挥合唱.webm',
  '挤番茄酱': 'assets/pet-gen/挤番茄酱.webm',
  '捏面人': 'assets/pet-gen/捏面人.webm',
  '换装侦探服思考': 'assets/pet-gen/换装侦探服思考.webm',
  '换装浴袍': 'assets/pet-gen/换装浴袍.webm',
  '掏耳朵': 'assets/pet-gen/掏耳朵.webm',
  '掰巧克力': 'assets/pet-gen/掰巧克力.webm',
  '搭帐篷': 'assets/pet-gen/搭帐篷.webm',
  '搭积木': 'assets/pet-gen/搭积木.webm',
  '摄影师打光': 'assets/pet-gen/摄影师打光.webm',
  '摇沙锤': 'assets/pet-gen/摇沙锤.webm',
  '摇铃铛报喜': 'assets/pet-gen/摇铃铛报喜.webm',
  '摘花送镜头': 'assets/pet-gen/摘花送镜头.webm',
  '撒盐调味': 'assets/pet-gen/撒盐调味.webm',
  '撒花瓣': 'assets/pet-gen/撒花瓣.webm',
  '擀饺子皮': 'assets/pet-gen/擀饺子皮.webm',
  '擦窗户': 'assets/pet-gen/擦窗户.webm',
  '收拾书桌': 'assets/pet-gen/收拾书桌.webm',
  '收纳行李箱': 'assets/pet-gen/收纳行李箱.webm',
  '放礼花筒': 'assets/pet-gen/放礼花筒.webm',
  '放飞纸飞机': 'assets/pet-gen/放飞纸飞机.webm',
  '敲木琴': 'assets/pet-gen/敲木琴.webm',
  '敲木鱼祈福': 'assets/pet-gen/敲木鱼祈福.webm',
  '敲锣打鼓拜年': 'assets/pet-gen/敲锣打鼓拜年.webm',
  '整理鞋柜': 'assets/pet-gen/整理鞋柜.webm',
  '敷面膜': 'assets/pet-gen/敷面膜.webm',
  '无语扶额': 'assets/pet-gen/无语扶额.webm',
  '服务生托盘': 'assets/pet-gen/服务生托盘.webm',
  '木匠锯木头': 'assets/pet-gen/木匠锯木头.webm',
  '梳理鲸鱼尾巴': 'assets/pet-gen/梳理鲸鱼尾巴.webm',
  '检票打孔': 'assets/pet-gen/检票打孔.webm',
  '水彩作画': 'assets/pet-gen/水彩作画.webm',
  '沙发打瞌睡': 'assets/pet-gen/沙发打瞌睡.webm',
  '洗碗': 'assets/pet-gen/洗碗.webm',
  '洗脸': 'assets/pet-gen/洗脸.webm',
  '涂口红': 'assets/pet-gen/涂口红.webm',
  '消防员持水枪': 'assets/pet-gen/消防员持水枪.webm',
  '深蹲举杠铃': 'assets/pet-gen/深蹲举杠铃.webm',
  '滑雪': 'assets/pet-gen/滑雪.webm',
  '滴眼药水': 'assets/pet-gen/滴眼药水.webm',
  '潜水比手势': 'assets/pet-gen/潜水比手势.webm',
  '玩手机': 'assets/pet-gen/phone.webm',
  '游泳': 'assets/pet-gen/swim.webm',
  '点许愿灯': 'assets/pet-gen/点许愿灯.webm',
  '烤饼干': 'assets/pet-gen/烤饼干.webm',
  '煮泡面': 'assets/pet-gen/煮泡面.webm',
  '熨衣服': 'assets/pet-gen/熨衣服.webm',
  '熬夜刷手机': 'assets/pet-gen/熬夜刷手机.webm',
  '狂喜原地跳': 'assets/pet-gen/狂喜原地跳.webm',
  '理发师剪发': 'assets/pet-gen/理发师剪发.webm',
  '瑜伽树式': 'assets/pet-gen/瑜伽树式.webm',
  '生气鼓腮跺脚': 'assets/pet-gen/生气鼓腮跺脚.webm',
  '甩拉面': 'assets/pet-gen/甩拉面.webm',
  '画家调色': 'assets/pet-gen/画家调色.webm',
  '看恐怖片捂眼': 'assets/pet-gen/看恐怖片捂眼.webm',
  '站着晃神打瞌睡': 'assets/pet-gen/站着晃神打瞌睡.webm',
  '系围裙': 'assets/pet-gen/系围裙.webm',
  '紧张搓手抖': 'assets/pet-gen/紧张搓手抖.webm',
  '织毛衣': 'assets/pet-gen/织毛衣.webm',
  '绸带舞': 'assets/pet-gen/绸带舞.webm',
  '缝扣子': 'assets/pet-gen/缝扣子.webm',
  '耍流星锤': 'assets/pet-gen/耍流星锤.webm',
  '脚麻了': 'assets/pet-gen/脚麻了.webm',
  '舔冰淇淋球': 'assets/pet-gen/舔冰淇淋球.webm',
  '舞狮': 'assets/pet-gen/舞狮.webm',
  '花艺师包花': 'assets/pet-gen/花艺师包花.webm',
  '蛋糕裱花': 'assets/pet-gen/蛋糕裱花.webm',
  '衣服标签刺痒': 'assets/pet-gen/衣服标签刺痒.webm',
  '袖口太长': 'assets/pet-gen/袖口太长.webm',
  '袜子破洞': 'assets/pet-gen/袜子破洞.webm',
  '被阳光晃眼': 'assets/pet-gen/被阳光晃眼.webm',
  '被雨淋': 'assets/pet-gen/被雨淋.webm',
  '被风吹跑帽子': 'assets/pet-gen/被风吹跑帽子.webm',
  '观星指认': 'assets/pet-gen/观星指认.webm',
  '警察开罚单': 'assets/pet-gen/警察开罚单.webm',
  '贴春联': 'assets/pet-gen/贴春联.webm',
  '走路': 'assets/pet-gen/走路.webm',
  '跳绳-减肥': 'assets/pet-gen/跳绳-减肥.webm',
  '跳芭蕾': 'assets/pet-gen/跳芭蕾.webm',
  '跳街舞': 'assets/pet-gen/跳街舞.webm',
  '踢踏舞': 'assets/pet-gen/踢踏舞.webm',
  '踩到香蕉皮': 'assets/pet-gen/踩到香蕉皮.webm',
  '踩高跷': 'assets/pet-gen/踩高跷.webm',
  '踮脚换灯泡': 'assets/pet-gen/踮脚换灯泡.webm',
  '蹦迪-戴墨镜': 'assets/pet-gen/蹦迪-戴墨镜.webm',
  '转呼啦圈': 'assets/pet-gen/转呼啦圈.webm',
  '转魔方': 'assets/pet-gen/转魔方.webm',
  '递包裹': 'assets/pet-gen/递包裹.webm',
  '递药和水': 'assets/pet-gen/递药和水.webm',
  '逗狗': 'assets/pet-gen/逗狗.webm',
  '逗猫': 'assets/pet-gen/逗猫.webm',
  '逗蝴蝶': 'assets/pet-gen/逗蝴蝶.webm',
  '量体温': 'assets/pet-gen/量体温.webm',
  '钉钉子挂画': 'assets/pet-gen/钉钉子挂画.webm',
  '钓鱼': 'assets/pet-gen/钓鱼.webm',
  '铺床单': 'assets/pet-gen/铺床单.webm',
  '陶艺拉坯': 'assets/pet-gen/陶艺拉坯.webm',
  '雪克杯摇奶茶': 'assets/pet-gen/雪克杯摇奶茶.webm',
  '鞋带松了': 'assets/pet-gen/鞋带松了.webm',
  '风扇前啊啊叫': 'assets/pet-gen/风扇前啊啊叫.webm',
  '魔术师变出花': 'assets/pet-gen/魔术师变出花.webm',
});
export const CLIPS = Object.freeze({
  ...GEN_CLIPS,
  idle: 'assets/pet-import/待机呼吸休闲.webm',
  idle_look: 'assets/pet-import/东张西望.webm',
  idle_hum: 'assets/pet-import/悠闲哼歌.webm',
  walk: 'assets/pet/walk.webm',
  walk_fast: 'assets/pet-import/侧身急躁跑.webm',
  run_happy: 'assets/pet/run_happy.webm',
  run_hurry: 'assets/pet-import/侧身急躁跑.webm',
  // 公开模板不含用户私有的背面帧；保留 key，用正面待机兜底。
  back_idle: 'assets/pet/idle.webm',
  sleep_in: 'assets/pet-import/睡觉-开始.webm',
  sleep_loop: 'assets/pet-import/睡觉-循环.webm',
  sleep_out: 'assets/pet-import/睡觉-起来.webm',
  eat_rice: 'assets/pet-import/吃饭·碗饭.webm',
  eat_snack: 'assets/pet-import/大口吃零食.webm',
  wait_food: 'assets/pet-import/期待开饭.webm',
  brush: 'assets/pet-import/晨间刷牙.webm',
  mirror: 'assets/pet-import/照镜子.webm',
  desk_code: 'assets/pet-import/写代码.webm',
  desk_tap: 'assets/pet-import/原地敲击桌面互动.webm',
  desk_mutter: 'assets/pet-import/碎碎念-对屏碎碎念.webm',
  fan: 'assets/pet-import/摇扇纳凉.webm',
  mooncake: 'assets/pet-import/中秋赏月吃月饼.webm',
  kite: 'assets/pet-import/放风筝.webm',
  react_happy: 'assets/pet-import/点击回应-开心跃动.webm',
  react_shy: 'assets/pet-import/点击回应-害羞惊讶.webm',
  react_scare: 'assets/pet-import/被吓一跳.webm',
  stretch: 'assets/pet-import/超大伸懒腰.webm',
  sick: 'assets/pet/sick.webm',
  game: 'assets/pet-import/原地专心玩魔方.webm',
  dance: 'assets/pet-import/轻快摇摆舞.webm',
  nap: 'assets/pet-import/原地小憩沉眠.webm',
  curtsy: 'assets/pet-import/女仆屈膝礼仪.webm',
  yawn: 'assets/pet-import/哈欠连天.webm',
  mutter: 'assets/pet/mutter.webm'
});

const POSTER = Object.fromEntries(Object.keys(CLIPS).map((k) => [k, `assets/pet/${k}.png`]));
const PLANE_W = 1.422;
const PLANE_H = 1.6;
const TARGET_H = 1.78;   // 统一身高（米）：和精灵图动作包对齐
const FEET_CENTER_Y = 0.667;
const CLIP_FOOT = new Map();   // clip src -> mesh.position.y（脚底贴到 y=0 时的高度） // 角色脚底在画面 91.7% 高度处，保证脚踩在地面
const FADE_MS = 260;
// 躺/睡片段（画面下缘就在脚底线上）贴在床上时，床垫+被子被面比 spot 的 elev
// 高出约 0.12：立绘是竖直平面，低于被面的那截会被床品挡住，看起来像下半身被切。
// 这里给躺姿一点抬升，让身体下缘落在被面上；站姿（elev=0 / 地面）不受影响。
const LIE_CLIPS = Object.freeze(new Set(['nap', 'sleep_in', 'sleep_loop', 'sleep_out']));
const LIE_SURFACE_LIFT = 0;

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 8, 128, 128, 120);
  g.addColorStop(0, 'rgba(24,28,34,.5)');
  g.addColorStop(0.45, 'rgba(24,28,34,.2)');
  g.addColorStop(1, 'rgba(24,28,34,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(128, 128, 120, 92, 0, 0, Math.PI * 2);
  ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

class Layer {
  constructor(scene, index) {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.loop = true;
    this.video.preload = 'auto';
    // 离屏 video 也要进入 DOM：部分 Chromium 对完全脱离文档的第二个 video
    // 会一直停在 readyState=0（本次新跑姿就撞上了），不是编码问题。
    this.video.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px;pointer-events:none';
    document.body.appendChild(this.video);
    this.texture = new THREE.VideoTexture(this.video);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: index === 0 ? 1 : 0,
      alphaTest: 0.02,
      depthWrite: true,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_W, PLANE_H), this.material);
    this.mesh.position.set(0, FEET_CENTER_Y, index * 0.0015);
    this.mesh.visible = false;
    this.src = '';
    this.loadLog = [];
    this.fade = 0;
    this.target = 0;
    scene.add(this.mesh);
  }
  load(src) {
    // 同一个源已经解码好：直接完成。
    this.loadLog.push({ s: src, p: 'start', rs: this.video.readyState });
    if (this.loadLog.length > 12) this.loadLog.shift();
    // 否则先挂监听再设置 src ——
    // 预取/缓存命中时 loadeddata 可能在监听挂上之前就触发，旧写法会白等 4.5s 超时。
    if (this.src === src) {
      if (this.video.readyState >= 2) return Promise.resolve();
      // 关键：轮询会重复 setClip 同一个片段。若这里重新赋值 src/load()，
      // 会把上一笔加载中止，结果永远停在 idle。复用同一笔 Promise。
      if (this._pendingLoad) return this._pendingLoad;
    }
    this.src = src;
    this.mesh.visible = true;
    this._bboxDone = false;
    const pending = new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.loadLog.push({ s: src, p: 'finish', rs: this.video.readyState });
        this.measureHead();
        try { this.alignFeet(); } catch { /* 忽略 */ }
        resolve();
      };
      this.video.addEventListener('loadeddata', finish, { once: true });
      this.video.addEventListener('canplay', finish, { once: true });
      this.video.addEventListener('error', finish, { once: true });
      // 素材版本号：改动 webm 后只要改这里，浏览器就不会再用旧缓存
  const ASSET_VER = '20261113a';
  this.video.src = src + (src.includes('?') ? '&' : '?') + 'v=' + ASSET_VER;
      this.video.load();
      // 离屏 video 不主动 play 时，部分 Chromium 会停在 readyState=0；
      // muted 的 play 只是催加载，真正淡入仍等 setClip。
      this.video.play().catch(() => {});
      if (this.video.readyState >= 2) finish();
      setTimeout(finish, 4500);
    });
    this._pendingLoad = pending;
    pending.finally(() => { if (this._pendingLoad === pending) this._pendingLoad = null; });
    return pending;
  }
  // 量头顶宽（顶部 30% 条带的横向宽度），只用于两套素材的头部比例对齐
  measureHead() {
    if (this.headWorld) return;
    const v = this.video;
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) return;
    const sw = 160;
    const sh = Math.max(1, Math.round((vh / vw) * sw));
    try {
      const c = document.createElement('canvas');
      c.width = sw;
      c.height = sh;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, sw, sh);
      ctx.drawImage(v, 0, 0, sw, sh);
      const data = ctx.getImageData(0, 0, sw, sh).data;
      let minY = sh, maxY = -1;
      for (let y = 0; y < sh; y++) {
        const row = y * sw * 4;
        for (let x = 0; x < sw; x++) {
          if (data[row + x * 4 + 3] > 24) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
        }
      }
      if (maxY <= minY) return;
      const bandEnd = Math.min(maxY, minY + Math.round((maxY - minY) * 0.3));
      let hMinX = sw, hMaxX = -1;
      for (let y = minY; y <= bandEnd; y++) {
        const row = y * sw * 4;
        for (let x = 0; x < sw; x++) {
          if (data[row + x * 4 + 3] > 24) { if (x < hMinX) hMinX = x; if (x > hMaxX) hMaxX = x; }
        }
      }
      if (hMaxX > hMinX) {
        const groupScale = this.mesh.parent ? this.mesh.parent.scale.y || 1 : 1;
        this.headWorld = ((hMaxX - hMinX + 1) / sw) * PLANE_W * groupScale;
      }
    } catch { /* 忽略 */ }
  }

  applyBboxSoon() {
    // 只在片段切换后尝试少量几次，绝不在每帧里反复全分辨率扫描
    this._bboxTries = 0;
    this._bboxDone = false;
    this._bboxNextAt = 0;
  }

  // 用低分辨率缩略图算包围盒（160px 宽），成本是原来的 1/25，且最多算 3 次
  applyBbox() {
    const v = this.video;
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) return false;
    if (this._bboxDone) return true;
    if ((this._bboxTries || 0) >= 3) { this._bboxDone = true; return false; }
    const now = performance.now();
    if (now < (this._bboxNextAt || 0)) return false;
    this._bboxTries = (this._bboxTries || 0) + 1;
    this._bboxNextAt = now + 200;

    const sw = 160;
    const sh = Math.max(1, Math.round((vh / vw) * sw));
    let box = null;
    try {
      const c = document.createElement('canvas');
      c.width = sw;
      c.height = sh;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, sw, sh);
      ctx.drawImage(v, 0, 0, sw, sh);
      const data = ctx.getImageData(0, 0, sw, sh).data;
      let minX = sw, minY = sh, maxX = -1, maxY = -1;
      for (let y = 0; y < sh; y++) {
        const row = y * sw * 4;
        for (let x = 0; x < sw; x++) {
          if (data[row + x * 4 + 3] > 24) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX > minX && maxY > minY) box = { minX, minY, maxX, maxY };
    } catch { box = null; }
    if (!box) return false;

    this._bboxDone = true;
    const fracH = (box.maxY - box.minY + 1) / sh;
    const fracFeet = box.maxY / sh;
    const fracCx = (box.minX + box.maxX) / 2 / sw;
    const groupScale = this.mesh.parent ? this.mesh.parent.scale.y || 1 : 1;
    const quadH = TARGET_H / Math.max(0.25, fracH) / groupScale;
    const quadW = quadH * (vw / vh);
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.PlaneGeometry(quadW, quadH);
    this.mesh.position.y = (fracFeet - 0.5) * quadH;
    this.mesh.position.x = (0.5 - fracCx) * quadW;
    return true;
  }

  // 每段动画的构图高度不一样（有的角色画面偏低/偏高），
  // 用首帧 alpha 包围盒把「脚底」对齐到组原点 y=0，避免同一支撑面上有的悬空有的陷进去。
  alignFeet() {
    if (this._footDone) return;
    const key = this.src;
    if (!key) return;
    if (CLIP_FOOT.has(key)) {
      this.mesh.position.y = CLIP_FOOT.get(key);
      this._footDone = true;
      return;
    }
    const v = this.video;
    if (!v.videoWidth || !v.videoHeight) return;
    let fracFeet = null;
    try {
      const sw = 160;
      const sh = Math.max(1, Math.round((v.videoHeight / v.videoWidth) * sw));
      const c = document.createElement('canvas');
      c.width = sw;
      c.height = sh;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, sw, sh);
      ctx.drawImage(v, 0, 0, sw, sh);
      const data = ctx.getImageData(0, 0, sw, sh).data;
      let maxY = -1;
      for (let y = 0; y < sh; y += 1) {
        const row = y * sw * 4;
        for (let x = 0; x < sw; x += 1) {
          if (data[row + x * 4 + 3] > 24) { maxY = y; break; }
        }
      }
      if (maxY > 0) fracFeet = (maxY + 1) / sh;
    } catch { fracFeet = null; }
    if (!fracFeet) return;
    // 脚底 y=0 对应的 mesh.position.y
    const ideal = (fracFeet - 0.5) * PLANE_H;
    const clamped = Math.max(FEET_CENTER_Y - 0.18, Math.min(FEET_CENTER_Y + 0.18, ideal));
    CLIP_FOOT.set(key, clamped);
    this.mesh.position.y = clamped;
    this.footFrac = fracFeet;
    this._footDone = true;
  }

  play() {
    this.video.play().catch(() => {});
  }
  setTarget(v) { this.target = v; }
  tick(dt) {
    if (this.fade !== this.target) {
      const step = dt * 1000 / FADE_MS;
      this.fade += Math.sign(this.target - this.fade) * Math.min(step, Math.abs(this.target - this.fade));
      this.material.opacity = this.fade;
      if (this.fade <= 0.001) {
        this.mesh.visible = false;
        try { this.video.pause(); } catch { /* 忽略 */ }
      } else this.mesh.visible = true;
    }
  }
}

export class SpriteActor {
  constructor(scene, { onEnded } = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'da-feiyu-sprite';
    this.group.scale.setScalar(1.28);
    scene.add(this.group);
    // 三层轮换：切换时永远有一层在显示，避免 2 层交替时把可见层淡出导致瞬间消失
    this.layers = [new Layer(this.group, 0), new Layer(this.group, 1), new Layer(this.group, 2)];
    this.active = 0;
    this.current = '';
    this.onEnded = onEnded;
    this.endedHandler = null;
    this.flip = false;
    this.ready = false;
    this.visible = true;
    this.clipLog = [];

    // 脚下阴影：地面一份；坐/躺时再给接触面一份
    const st = shadowTexture();
    this.floorShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: st, transparent: true, depthWrite: false, opacity: 0.9 })
    );
    this.floorShadow.rotation.x = -Math.PI / 2;
    this.floorShadow.position.y = 0.008;
    this.floorShadow.scale.set(0.62, 0.38, 1);
    scene.add(this.floorShadow);
    this.surfaceShadow = this.floorShadow.clone();
    this.surfaceShadow.material = this.floorShadow.material.clone();
    this.surfaceShadow.material.opacity = 0.55;
    scene.add(this.surfaceShadow);
    this._pos = new THREE.Vector2(6.3, 5.1);
    this._target = new THREE.Vector2(6.3, 5.1);
    this._elev = 0;
    this._targetElev = 0;
    this._lift = 0;
    this._walking = false;
    this._time = 0;
  }

  async prime(name = 'idle') {
    const layer = this.layers[this.active];
    await layer.load(CLIPS[name]);
    layer.setTarget(1);
    layer.fade = 1;
    layer.material.opacity = 1;
    layer.play();
    this.current = name;
    this.ready = true;
  }

  // 预取移动用的两种跑姿；真正切换仍走 setClip，避免首次出发还在等视频加载。
  prefetch(names = []) {
    if (!Array.isArray(names) || !names.length) return;
    this._prefetch = this._prefetch || [];
    for (const name of names) {
      if (!CLIPS[name] || this._prefetch.some((x) => x.name === name)) continue;
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.src = CLIPS[name];
      v.load();
      this._prefetch.push({ name, el: v });
    }
  }

  // 选一个「最不该被用户看到」的层给下一段动画用：
  // 正在淡入的层优先保护，其次是不透明/可见的层。
  _pickSpare() {
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < this.layers.length; i += 1) {
      if (i === this.active) continue;
      const l = this.layers[i];
      const score = (l.target === 1 ? 100 : 0) + (l.fade || 0) + (l.mesh.visible ? 1 : 0);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) best = (this.active + 1) % this.layers.length;
    return best;
  }

  async setClip(name, { once = false, fade = true, onEnded = null } = {}) {
    if (!CLIPS[name]) name = 'idle';
    this.clipLog.push({ n: name, p: 'start', cur: this.current, a: this.active });
    if (this.clipLog.length > 20) this.clipLog.shift();
    if (this.current === name && !once) return;
    const nextIndex = this._pickSpare();
    const next = this.layers[nextIndex];
    const prev = this.layers[this.active];
    next.mesh.visible = true;
    // 清掉这个图层上一轮留下的“跳过前摇后手动循环”监听，避免叠监听。
    if (next.video._trimEnded) {
      next.video.removeEventListener('ended', next.video._trimEnded);
      next.video._trimEnded = null;
    }
    // 不在这里 await 视频：轮询/连续 setClip 时，等待会让 current 一直停在 idle。
    // 先把逻辑片段切过去，视频 ready 后再淡入；加载失败也不会卡住移动。
    const loaded = next.load(CLIPS[name]);
    // 前摇裁剪与「只播一次」无关：动作面板点播时也要跳过起势。
    const trimStart = LOOP_TRIM[name] || 0;
    next.video.loop = !once && !trimStart;
    if (trimStart && !once) {
      // 不用 loop 属性：loop 会从 0 重播，前摇每次循环都会出现。
      const onTrimEnded = () => {
        if (this.current !== name) return;
        // 循环回到开头时同样用快进冲过前摇（seek 不可靠）
        next.video.playbackRate = 8;
        next.video.play().catch(() => {});
        const t0 = performance.now();
        const step = () => {
          if (this.current !== name) { next.video.playbackRate = 1; return; }
          if (next.video.currentTime >= trimStart || performance.now() - t0 > 1200) {
            next.video.playbackRate = 1;
            return;
          }
          setTimeout(step, 40);
        };
        step();
      };
      next.video.addEventListener('ended', onTrimEnded);
      next.video._trimEnded = onTrimEnded;
    }
    if (trimStart) {
      // 这些片段关键帧很少，seek 会落回首帧；改成「高倍速快进」把前摇冲掉。
      next.video.playbackRate = 8;
    }
    next.mesh.visible = true;
    next.fade = 0;
    next.material.opacity = 0;
    next.setTarget(0);
    if (once) {
      this.endedHandler = () => {
        if (this.current === name) {
          this.onEnded?.(name);
          onEnded?.();
        }
      };
      next.video.addEventListener('ended', this.endedHandler, { once: true });
    }
    this.active = nextIndex;
    this.current = name;
    // 只清理已经不可见的层；正在显示的那层必须留到下一段真正 ready 再淡出，
    // 否则「旧层已淡出、新层还在加载」就会空一段（消失一会儿）。
    for (let i = 0; i < this.layers.length; i += 1) {
      if (i === nextIndex) continue;
      const l = this.layers[i];
      if ((l.fade || 0) < 0.02) l.setTarget(0);
    }
    this._lastSwap = performance.now();
    loaded.then(() => {
      if (this.current !== name) return;
      if (trimStart) {
        // 快进冲过前摇：到时（或最多 1.2s）后恢复正常速度并淡入
        next.video.playbackRate = 8;
        const startedAt = performance.now();
        const finishIntro = () => {
          if (this.current !== name) { next.video.playbackRate = 1; return; }
          next.video.playbackRate = 1;
          next.play();
          next.setTarget(1);
          if (fade) {
            prev.setTarget(0);
          } else {
            prev.fade = 0;
            prev.material.opacity = 0;
          }
        };
        const step = () => {
          if (this.current !== name) { next.video.playbackRate = 1; return; }
          const played = next.video.currentTime;
          if (played >= trimStart || performance.now() - startedAt > 1200) { finishIntro(); return; }
          next.play();
          setTimeout(step, 40);
        };
        step();
        return;
      }
      // 只在需要裁前摇时才 seek。无脑设 currentTime=0 会触发一次 seek，
      // VP9 要重新解码首帧，表现就是「切过去前几帧不动」。
      if (trimStart > 0.01) {
        try { next.video.currentTime = trimStart; } catch { /* 还没元数据 */ }
      }
      next.play();
      next.setTarget(1);
      if (fade) {
        prev.setTarget(0);
      } else {
        prev.fade = 0;
        prev.material.opacity = 0;
        prev.mesh.visible = false;
        next.fade = 1;
        next.material.opacity = 1;
        try { prev.video.pause(); } catch { /* 忽略 */ }
      }
    }).catch(() => {});
    return loaded;
  }

  // 基础素材的头顶宽度（世界单位），用于让新动作包头宽一致
  get headWorld() {
    for (const l of this.layers) if (l.headWorld) return l.headWorld;
    return 0;
  }

  setVisible(v) {
    this.visible = v;
    this.group.visible = v;
    this.floorShadow.visible = v;
    this.surfaceShadow.visible = v;
  }

  update(dt, camera, { pos, elev = 0, walking = false, flip = false, faceCamera = true, snap = false }) {
    this._time += dt;
    this._target.set(pos[0], pos[1]);
    const d = this._pos.distanceTo(this._target);
    if (d > 2.2) this._pos.copy(this._target);
    else {
      const k = 1 - Math.pow(0.001, dt);
      this._pos.lerp(this._target, Math.min(1, k * 1.4));
    }
    this._targetElev = elev;
    // 只有躺在抬高的床面上才抬升：地面上的 nap（elev≈0）保持原来的落脚。
    const lieLift = LIE_CLIPS.has(this.current) && elev > 0.2 ? LIE_SURFACE_LIFT : 0;
    if (snap) {
      // 截图模式只画一帧，缓动来不及收敛；直接吸附到目标值，画面才是真实姿态。
      this._pos.copy(this._target);
      this._elev = elev;
      this._lift = lieLift;
    } else {
      this._elev += (this._targetElev - this._elev) * Math.min(1, dt * 4.5);
      this._lift += (lieLift - this._lift) * Math.min(1, dt * 7);
    }
    this._walking = walking;

    const bob = walking ? Math.abs(Math.sin(this._time * 7.2)) * 0.014 : Math.sin(this._time * 1.7) * 0.006;
    this.group.position.set(this._pos.x, this._elev + this._lift + (walking ? bob : 0), this._pos.y);
    if (faceCamera) {
      const dx = camera.position.x - this._pos.x;
      const dz = camera.position.z - this._pos.y;
      this.group.rotation.y = Math.atan2(dx, dz);
    }
    this.flip = flip;
    const sx = flip ? -1 : 1;
    for (const l of this.layers) l.mesh.scale.x = sx;
    for (const l of this.layers) l.tick(dt);

    // 阴影
    this.floorShadow.position.set(this._pos.x, 0.008, this._pos.y);
    this.floorShadow.scale.setScalar(walking ? 0.6 + Math.sin(this._time * 7.2) * 0.03 : 0.62);
    const sitting = this._elev > 0.1;
    this.surfaceShadow.visible = this.visible && sitting;
    if (sitting) {
      this.surfaceShadow.position.set(this._pos.x, this._elev + this._lift + 0.006, this._pos.y);
      this.surfaceShadow.scale.set(0.52, 0.32, 1);
      this.surfaceShadow.material.opacity = 0.5;
    }
    this.floorShadow.material.opacity = sitting ? 0.18 : 0.55;
  }

  /** 截图模式：用预生成的透明 PNG，避免无头浏览器等视频首帧。 */
  async prepareShotPoster(name) {
    const key = CLIPS[name] ? name : 'idle';
    const layer = this.layers[this.active];
    try {
      const tex = await new THREE.TextureLoader().loadAsync(POSTER[key] || POSTER.idle);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      const old = layer.material.map;
      layer.material.map = tex;
      layer.material.opacity = 1;
      layer.material.needsUpdate = true;
      layer.mesh.visible = true;
      layer.video.pause();
      this.current = key;
      if (old && old !== tex) { try { old.dispose(); } catch { /* 忽略 */ } }
      return true;
    } catch {
      return this.prepareShot(key, 2.4).then(() => true).catch(() => false);
    }
  }

  /** 截图模式：不用真的等播放，直接把视频 seek 到指定帧。 */
  async prepareShot(name, seconds = 2.4) {
    const layer = this.layers[this.active];
    const srcPath = CLIPS[name] || CLIPS.idle;
    await layer.load(srcPath);
    layer.video.pause();
    layer.video.currentTime = seconds;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        // 这里的 this 是 SpriteActor，日志在 layer 上
        try { layer.loadLog?.push({ s: srcPath, p: 'finished', rs: layer.video.readyState }); } catch { /* 忽略 */ }
        resolve();
      };
      layer.video.addEventListener('seeked', finish, { once: true });
      setTimeout(finish, 1200);
    });
    layer.video.pause();
    layer.material.opacity = 1;
    layer.mesh.visible = true;
    this.current = name;
  }

  dispose() {
    for (const l of this.layers) {
      try { l.video.pause(); l.video.src = ''; } catch { /* 忽略 */ }
      l.texture.dispose();
      l.material.dispose();
      l.mesh.geometry.dispose();
    }
    this.floorShadow.geometry.dispose();
    this.floorShadow.material.dispose();
    this.surfaceShadow.material.dispose();
  }
}
