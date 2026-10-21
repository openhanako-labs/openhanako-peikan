# NOTICE

## 第三方代码

本项目的部分实现派生自以下项目，按其原始许可使用：

---

### dsh-bili-whale

```
Copyright (c) 2026 ALTERSSSS
License: MIT
https://github.com/ALTERSSSS/dsh-bili-whale
```

**MIT 许可证全文：**

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 派生清单

以下部分**直接派生或改写**自 dsh-bili-whale：

| 本项目文件 | 对应源码 | 关系 |
|---|---|---|
| `peikan/lib/msgfeed.js` 的 `resolveReply()` | `tools/lib/msgfeed.mjs` 的 `resolveLatestReply()` | **派生**。结构、变量命名、循环上限（`pn <= 6`）、页大小（`ps=20`）、跳出条件（`page.length < 20`）、`[...mine].reverse().find()` 的匹配方式、`exact` 标记，均与原实现一致；改为通过宿主 `sdk.network.fetch` 调用 |
| `peikan/lib/msgfeed.js` 的收件箱拉取 | `tools/lib/msgfeed.mjs` 的 `pullFeed()` | **相同**。端点 `/x/msgfeed/{kind}` 与查询串 `platform=web&build=0&mobi_app=web` 完全一致 |
| `peikan/lib/risk.js` 的风控码表 | `tools/commands/comment.mjs` | **思路来源**。错误码 `12015`（需验证码）、`412`（限流）、`-352`（风控校验）的语义与「撞风控立刻停手」的红线，来自该文件注释与实现；本项目的三档冷却分级（cooldown / manual / ignore）为自行设计 |
| `peikan/lib/share.js` 的同视频冷却 | `README.md` 的硬限制 | **取值来源**。「同一视频 7 天内一次」直接取自该项目 README |
| `peikan/lib/reply.js` 的同一人冷却 | `README.md` 的硬限制 | **取值来源**。「同一个人（可选）30 天只回一次」直接取自该项目 README |
| `peikan/lib/brain.js` 的事件解析 | `tools/lib/*` | **思路来源**。对 `text-delta` / `tool-call` / `done` 流事件的分类处理方式参考自该项目，本项目额外处理了 `reasoning-delta`（推理模型） |
| `peikan/lib/frames.js` 的抽帧流程 | `tools/lib/ffmpeg.mjs` | **思路来源**。下载 → ffmpeg 抽帧 → tile 拼图的三段流程参考自该项目 |

---

## 未复制的内容

以下部分为本项目独立实现，未参考上述源码：

- 全部 UI（`peikan/ui/`）——包括三个界面和设计系统
- `peikan/lib/gate.js` 五道闸门的判定逻辑
- `peikan/lib/quota.js` 配额账本
- `peikan/lib/taste.js` 口味学习
- `peikan/lib/rhythm.js` 生物钟
- `peikan/lib/identity.js` 人格分层读取
- `peikan/lib/reach.js` / `fans.js`（回响、粉丝）
- `peikan/lib/video-meta.js`
- 全部 578 项测试

---

## 许可兼容性说明

dsh-bili-whale 采用 MIT 协议，允许「再授权为更严格的协议」，条件是**保留原始版权声明与许可声明**（见上方 MIT 全文第二段）。

本项目整体采用 **AGPL-3.0**（与 OpenHanako 组织惯例一致），同时：

1. 保留 dsh-bili-whale 的完整 MIT 许可声明（本文档）
2. 在 `LICENSE` 文件头部注明派生关系
3. 未对派生部分附加任何限制性条款

因此本项目对衍生部分的再授权是合规的。

---

*如有遗漏或界定不当，欢迎提 issue 纠正。*
