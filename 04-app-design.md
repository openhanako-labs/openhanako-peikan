# 奥菲莉娅 · B站 Agent · App 设计稿（v0.1）

> 状态：设计稿（待真实账号注册后进入实施）
> 形态：Hana v2 App（独立，自持 auth / session / 发布）
> 前序：`03-integration-architecture.md`（分层与责任边界）

## 0. 一句话定位
把奥菲莉娅的「笔记本」做成一个能自己过日子的 Hana App：它自己刷 B站、写观察笔记、偶尔自发作帖，
所有发布先过一道写死的闸门——**它住在 Hana 里，不依赖 DSH，不依赖 bilibili-intake 运行时**。

## 1. 技术地基（已从 Hana 契约确认）
| 需求 | Hana 原生机制 | 出处 |
|---|---|---|
| 生物钟（自己醒） | `tasks.schedule({handlerKey, intervalMs \| runAt})` + `tasks.registerHandler()` | `sdk/app-contract/tasks.d.ts` |
| 叫醒会话 | `bus.request('session:send', …)`，需 `app/session.start-turn` | `sdk/app-bus-contract.d.ts` / `app-session-control-capabilities.d.ts` |
| 发消息进会话 | `session:send` / `session:send-custom`（后者可 `triggerTurn`） | `sdk/app-entity-capabilities.d.ts` |
| 数据落盘 | `sdk.dataDir`（App 私有数据目录） | `git-save-load/index.js` 用法 |
| 给模型工具 | `sdk.tools.register()` + `app/tools.expose-to-model` | 同上 |

**结论**：DSH 的 `sessionController.prompt` ≈ Hana 的 `session:send` + `app/session.start-turn`；DSH 每 60s tick ≈ Hana `tasks.schedule`。地基不需要自己造。

## 2. manifest 设计
```jsonc
{
  "manifestVersion": 2,
  "id": "ophelia-bili",
  "name": "奥菲莉娅 · B站",
  "version": "0.1.0",
  "entry": "index.js",
  "icon": "assets/icon.png",
  "minAppVersion": "0.1059.0",
  "capabilities": [
    "app/tools.expose-to-model",      // 把 bili_* 工具暴露给我
    "app/tasks.manage",               // 生物钟 / 监听 / 健康心跳
    "app/session.start-turn",         // 叫醒她的专用会话
    "app/sessions.read",              // 读会话 / 定位专用会话
    "app/sessions.manage",            // 往会话塞消息
    "app/resources.read", "app/resources.write",  // 数据文件
    "app/ui.open-external"            // 打开 B站 链接
  ],
  "network": {
    "allowedHosts": [
      "api.bilibili.com", "api.vc.bilibili.com", "api.live.bilibili.com",
      "www.bilibili.com", "bilibili.com", "*.bilibili.com", "s.search.bilibili.com"
    ],
    "methods": ["GET", "POST"],
    "allowLocalhost": false,
    "defaultTimeoutMs": 30000
  },
  "contributes": {
    "cards": [{ /* 工作室面板，见 §7 */ }],
    "settings": { /* 配置 schema，见 §8 */ }
  }
}
```
> 命名 `ophelia-bili` 为占位，落地前可改。网络白名单只开 B站 域，不开 localhost。

## 3. 目录结构
```
ophelia-bili/
├── manifest.json
├── index.js                 # defineApp：注册工具 + 定时任务 + 卡片
├── lib/
│   ├── auth.js              # 自持登录态：credentials / WBI 签名 / nav 校验 / 过期
│   ├── client.js            # 自持 B站 请求：feed / search / debrief / comment / dm / dynamic
│   ├── gate.js              # 决策闸门：ALLOW / HOLD / BLOCK（写死规则）
│   ├── quota.js             # 配额账：check / record（每日/同视频/同人）
│   ├── notes.js             # 观察笔记（她的笔记本）
│   ├── drafts.js            # 草稿箱
│   ├── review.js            # 人审队列
│   ├── diary.js             # 两本日记
│   ├── audit.js             # 审计日志（每次放行/拦截）
│   └── config.js            # 配置读写（dataDir/config.json）
├── tools/                   # 暴露给模型的工具（见 §6）
├── tasks/                   # 定时任务 handler（见 §5）
├── routes/                  # 卡片后端（工作台数据）
└── ui/                      # 卡片前端（工作室面板）
```
数据目录（`sdk.dataDir`）：
```
credentials.json      # SESSDATA/bili_jct/buvid3，0600，永不回显
config.json           # 作息/频率/口味/闸门参数
notes/                # 观察笔记 md + index.json
drafts/               # 草稿
review/               # 人审队列（待拍板）
diary-executive.md    # 给月曦夜的那本
diary-private.md      # 给她自己的那本
quota.json            # 配额账
audit.jsonl           # 审计流
state/                # 生物钟状态、去重基线
```

## 4. 模块 ↔ 架构分层映射
| 架构层（03） | 本 App 落地 | 说明 |
|---|---|---|
| 登录/会话层（自持） | `lib/auth.js` | credentials + WBI + 会话节奏 |
| 摄取层（自持） | `lib/client.js` | feed/search/debrief，只读 |
| 浏览循环 | `tasks/browse.js` + `lib/notes.js` | 拉流 → 写观察笔记 |
| 草稿生成 | `lib/drafts.js` | 草稿入箱，不直发 |
| 决策闸门（写死） | `lib/gate.js` | 三态判定，不交 LLM |
| 发布层（唯一写入口） | `lib/client.js` 的写函数 + `lib/quota.js` | 仅收 ALLOW |
| 人审层 | `lib/review.js` + 卡片 | HOLD → 拍板 → 回流 |

## 5. 定时任务（三条 schedule）
| handlerKey | 触发 | 做什么 |
|---|---|---|
| `night.plan` | 一次性 `runAt`（醒来时刻） | 算下一次醒来 → 到点 → `session:send` 叫醒专用会话 → 醒来后重排 |
| `night.wake` | 由 plan 投递 | 塞一轮「你醒了」提示词进专用会话（随机窗口 + 概率性「今天不看」） |
| `listen.poll` | `intervalMs`（默认 ≥60s） | 扫 回复/@/私信，有新东西 → 叫醒；无 → 零 token |
| `health.tick` | `intervalMs`（默认 30min） | 依赖体检 + 登录态校验 + 风控信号，异常停发告警 |

> 与 DSH 的差别：Hana 的 `tasks.schedule` 由宿主持久化，App 不需要常驻进程自旋——比 DSH 的 60s tick 更干净。

## 6. 暴露给模型的工具（bili_*）
> 工具是「她自己动手」的接口；闸门在工具内部强制，模型无法绕过。

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `bili_health` | 依赖体检 / 登录态 / 配额余量 | 只读 |
| `bili_feed` | 拉推荐流 / 搜索 / 关注动态 | 只读 |
| `bili_debrief` | 深读一条（字幕/弹幕/热评/抽帧） | 只读 |
| `bili_note` | 写观察笔记 | 写本地 |
| `bili_draft` | 建/列/改/弃草稿 | 写本地，不发布 |
| `bili_gate` | 过闸门预检（返回 ALLOW/HOLD/BLOCK + 理由） | 确定性规则 |
| `bili_publish` | 发布（动态/评论/私信） | **只接受 ALLOW**；内部再跑一次 gate + quota |
| `bili_review` | 人审队列：列/批/驳 | HOLD 产物 |
| `bili_diary` | 两本日记读写 | 本地 |
| `bili_quota` | 查配额账 | 只读 |

**闸门纵深**：`bili_gate` 是预检，`bili_publish` 内部**再跑一次**确定性 gate + quota——两道，模型改不了。

## 7. 卡片：工作室面板
一个 page 卡片，标签页：
- **笔记本**：观察笔记流（时间/来源/要点/裂隙标记）
- **草稿箱**：草稿列表 + 内含 gate 预检结果
- **待拍板**：HOLD 队列（一键批准/驳回，走 propose 式确认）
- **账本**：配额余额 + 审计流（放行/拦截各多少）
- **设置**：见 §8

视觉沿用你偏好的冷白 / 细线框 / 暗铜（瑞士国际主义），星象图纹做弱底纹，不喧宾夺主。

## 8. 配置 schema（settings）
- `persona`：name / ownerTitle / selfClaim（接 persona 基线 §6）
- `night`：windows[]（时段+次数）/ skipChance / maxVideos
- `preferences`：like[] / dislike[]
- `share`：enabled / via（comment|dm）/ minScore / rank=1
- `listen`：comment / allDay / dm / intervalSec
- `gate`：frequency caps（N/M/X/Y，**占位待标定**）/ 风控词表路径
- `safety`：身份隔离词表 / 停发开关（kill switch）

## 9. 凭据与安全边界（独立的核心）
- 凭据只存 `dataDir/credentials.json`，权限收窄，写入后**永不回显**（对齐 whale）。
- 不读 bilibili-intake 的 cookie 文件、不调其运行时、不跟其版本。
- 网络白名单只开 B站 域。
- **kill switch**：设置里一个总开关，一键停所有自主发布，只保留只读。
- 审计：每次放行/拦截落 `audit.jsonl`（时间戳/内容哈希/命中规则/决策）。

## 10. 分阶段实施
| 阶段 | 内容 | 前置 |
|---|---|---|
| P0 | 骨架 + manifest + 空卡片 + 工具注册（桩） | 无 |
| P1 | `lib/auth.js` 自持登录态（WBI + nav 校验） | 真实账号 cookie |
| P2 | 摄取层 `feed/search/debrief`（参考 intake 坑处理） | P1 |
| P3 | 观察笔记 + 浏览循环 schedule | P2 |
| P4 | 闸门 + 配额 + 草稿（先全 HOLD） | P3 |
| P5 | 发布层（最小 ALLOW 白名单）+ 风控监控 | 账号冷启动标定频率 |
| P6 | 卡片工作台 + 人审回流 | P4/P5 |

## 11. 待定 / 需标定
- 频率数值 N/M/X/Y：真实账号冷启动对照 B站 风控，当前占位，不当已验证安全值。
- `session:send` 的精确字段：以 `sdk/app-contract/bus-requests.d.ts` 的 `AppSessionSendRequestV2` 为准（实施时核对）。
- 抽帧是否引入 ffmpeg（`app/process.spawn`）：可选，不装则少一路画面分析。
- App 命名 `ophelia-bili`：占位，可改。
