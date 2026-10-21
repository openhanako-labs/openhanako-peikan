# 陪看 · Peikan

> 一个会用 B站 的助手：自己按作息醒来、看视频、写笔记、回评论，把值得的递给你。

不是「定时任务 + 关键词搜索」。是**生物钟 + 口味 + 克制**：一天只醒两三次，挑几条真想看的，写点自己的判断，偶尔递一条给你。

---

## 它是什么

一个 **Hana v2 App**。装上之后，它读你助手自己的 `identity.md` 和 `AGENTS.md` 当人格——**不内置任何角色设定**。你家助手是谁，它就是谁。

```
助手醒来 → 看收件箱 → 刷推荐 → 深读几条 → 写笔记 → 写日记 → 偶尔分享
```

每一轮约 40–90 秒，跑在宿主任务上下文里（不受工具回调的 30 秒窗口限制）。

---

## 它不会做什么

- ❌ 不主动给陌生人发私信
- ❌ 不去别人的视频下面发评论（有单独开关，默认关）
- ❌ 不在你沉默的时候继续推东西（沉默衰减）
- ❌ 撞到风控不会硬撑（412 / 12015 立刻停手冷却）

---

## 人格是空白的

这个 App **不预设角色**。它读的是：

```
<hanakoHome>/.hanako/agents/<agentId>/identity.md    ← 她是谁
<hanakoHome>/.hanako/agents/<agentId>/AGENTS.md      ← 她怎么干活
```

**这两份都是你自己写的。** 没有就退回中性助手，不撒娇、不叫主人、不说「人家」。

想换成别的人格：改那两个文件，或在这个 App 的设置页里写「覆盖版」（按助手分开存，不动原始文件）。

---

## 装

**前提**：Hana 宿主；一个 B站 账号；宿主里配好可用的模型。

1. 装上 App
2. 在「接入」页填 `SESSDATA` / `bili_jct` / `buvid3`（F12 → Application → Cookies）
3. 在「设置」页选助手、选模型、调作息和配额
4. 先去「笔记本」页手动叫醒一次，确认她能看东西

```bash
# 检查环境（不含 B站 凭据）
node scripts/check-env.mjs
```

---

## 它怎么过日子

| 步 | 做什么 |
|---|---|
| **醒来** | 在作息窗口内随机时刻；有 `skipChance` 概率「今天不想看」 |
| **听** | 先看收件箱——有人找她就先回，**没看收件箱就刷视频是不对的** |
| **筛** | 拉推荐流，按口味过滤（你的口味 ×0.7 + 她的 ×0.3） |
| **读** | 挑 1–2 条深读：详情 + 热评 + 字幕 + 弹幕统计 + 封面 |
| **记** | 写笔记（标题一句、判断一段）；写日记（两本，她自己写） |
| **递** | 有未回消息就不分享；否则从本轮笔记里挑一条私信给你 |

**硬限制（代码强制，不接受参数覆盖）：**

- 分享每天上限（默认 10）
- 同一视频 7 天内不重推
- 同一个人 30 天内只回一次（主人豁免）
- 撞风控立刻冷却（412 六小时 / 12015 需人工）

---

## 五道闸门

发布判定**不交给模型**。输入是草稿，输出是 `ALLOW / HOLD / BLOCK`，全是确定性比对。

| 闸 | 管什么 |
|---|---|
| **kill switch** | 总开关，关掉就只读 |
| **确定性闸门** | 身份信息、风控词、空正文 |
| **白名单 + 配额** | 能对谁说、说几次 |
| **沉默衰减** | 你多久没表态，额度就降多少 |
| **分享标尺** | 评分不到阈值不推 |

---

## 她能碰到什么

**16 个工具**（不是全部 47 个——其余是给人用的排障口）：

```
读    feed / debrief / inbox / echo / fans / my_day
写    note / diary / comment / reply / like / share / retract
改    edit_dynamic / follow / dynamic_image
```

**每一个写动作都有开关管着**，不是「给她就随便用」。

---

## 数据在哪

```
<dataDir>/
  credentials.json    凭据（写进去，永不回显）
  config.json         模型 / 配额 / 开关
  notes/index.json    笔记
  covers/             封面（本地缓存）
  diary-private.md    她自己那本
  diary-executive.md  给你那本
  audit.jsonl         每个对外动作的留痕
  taste.json          口味权重
  risk-state.json     风控冷却状态
```

**没有数据库、没有守护进程、没有云服务。** 状态全在普通文件里，人随时能打开看。

---

## 目录

```
peikan/
  index.js             入口（注册路由 / 工具 / 任务）
  manifest.json        App 声明
  lib/                 37 个模块
    auth.js            登录态 + WBI 签名
    client.js          B站 接口
    wake.js            一轮醒来（TOOLS + 工具执行器）
    brain.js           调模型（支持工具循环）
    gate.js            五道闸门
    quota.js           配额账本
    risk.js            风控熔断
    share.js           分享（含 7 天冷却）
    reply.js           回话（含 30 天冷却）
    taste.js           口味学习
    diary / note / store ...
  ui/                  三个界面（主界面 / 侧栏面板 / 设置）
  verify/              523 项测试
  DECISIONS.md         为什么这么做
  playbooks/           故障卡
```

---

## 测试

```bash
node verify/load-check.mjs      # 37 个模块能不能加载
node verify/run-check.mjs       # 核心流程
node verify/risk-check.mjs      # 风控熔断
node verify/ui-coverage-check.mjs  # 每个能力都有界面入口
```

**523 项，0 失败。**

几个测试专门防「同一行为多个出口，只改了一个」这个坑：

```
note-outlets-check    写笔记的所有出口都带元数据
gate-coverage-check   每条写通道都过闸门
schedule-dedup-check  排程不重复
```

---

## 边界

**它依赖**：Hana 宿主的 `network.fetch`（只允许 HTTPS）、`models.stream`、`tasks`、`resources.read`、`process.resolveExecutable`（抽帧用 ffmpeg）。

**不依赖**：任何外部服务、数据库、云。

**已知限制**：
- 图片必须是 `dataDir` 内的（宿主沙箱）
- B站 CDN 给的是 `http://`，代码里会升成 `https://`
- 直播间没做（只做投稿视频）

---

## 许可

MIT

---

*建立于 2026-10-20*
