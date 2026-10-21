/**
 * verify/taste-check.mjs — 口味档案 + 语义反馈
 *
 * 关键立场：她有自己的一份，主人的反馈是影响因子，不是命令。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const taste = await import(pathToFileURL(path.join(APP, "lib/taste.js")).href);
const feedback = await import(pathToFileURL(path.join(APP, "lib/feedback.js")).href);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.log(`  ✗ ${n} -> ${e?.message ?? e}`); };
const ta = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "taste-"));

console.log("[1] 口味档案：两边各一份");
await ta("记一笔就落盘", async () => {
  const d = mkDir();
  const r = taste.touch(d, "时政", { side: "owner", delta: -1 });
  assert.equal(r.ok, true);
  assert.ok(r.now.owner < 0, "owner 应该是负");
  assert.equal(r.now.mine, 0, "她自己的不该被改");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("她自己的判断独立于主人", async () => {
  const d = mkDir();
  taste.touch(d, "猫咪", { side: "mine", delta: 1 });
  taste.touch(d, "猫咪", { side: "owner", delta: -1 });
  const s = taste.snapshot(d);
  const cat = s.rows.find((r) => r.trait === "猫咪");
  assert.ok(cat.mine > 0, "她喜欢猫");
  assert.ok(cat.owner < 0, "主人不喜欢");
  assert.equal(cat.conflict, true, "应该标记为分歧");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("分歧被单独记下来", async () => {
  const d = mkDir();
  taste.touch(d, "凶案", { side: "mine", delta: 1, note: "结构值得看" });
  taste.touch(d, "凶案", { side: "owner", delta: -1, note: "我不看这类" });
  const s = taste.snapshot(d);
  assert.ok(s.divergences.length >= 1, "分歧记录没写");
  assert.equal(s.divergences[0].trait, "凶案");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("上下限被夹住，不会无限累加", async () => {
  const d = mkDir();
  for (let i = 0; i < 20; i += 1) taste.touch(d, "带货", { side: "mine", delta: -1 });
  const s = taste.snapshot(d);
  const row = s.rows.find((r) => r.trait === "带货");
  assert.ok(row.mine >= -1, `应该被夹在 -1，实际 ${row.mine}`);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2] 口味分：她的为主，主人的为辅");
await ta("只她表态 → 全按她的算", async () => {
  const d = mkDir();
  taste.touch(d, "游戏", { side: "mine", delta: 1 });
  const r = taste.scoreFor(d, "今天看了一个游戏解说");
  assert.ok(r.score > 0, `应该为正，实际 ${r.score}`);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("两边都有且相反 → 她的判断占上风（0.7 vs 0.3）", async () => {
  const d = mkDir();
  taste.touch(d, "凶案", { side: "mine", delta: 1 });
  taste.touch(d, "凶案", { side: "owner", delta: -1 });
  const r = taste.scoreFor(d, "一条凶案视频");
  assert.ok(r.score > 0, `她的判断该占上风，实际 ${r.score}`);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("只有主人表态 → 全按主人的算（不平白打三折）", async () => {
  const d = mkDir();
  taste.touch(d, "凶案", { side: "owner", delta: -1 });
  const r = taste.scoreFor(d, "一条凶案视频");
  // 她没数据时，owner 应该占满（约 -0.15），不是 -0.045
  assert.ok(r.score < -0.1, `主人的声音被稀释了，实际 ${r.score}`);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("没命中任何主题词 → 0", async () => {
  const d = mkDir();
  taste.touch(d, "猫咪", { side: "mine", delta: 1 });
  const r = taste.scoreFor(d, "完全无关的内容");
  assert.equal(r.score, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[2.5] 线索词：抽象标签能命中具体叙述");
await ta("「被杀死的婴儿」命中「凶案」", async () => {
  const d = mkDir();
  taste.touch(d, "凶案", { side: "owner", delta: -1 });
  // 这段文字里没有「凶案」二字，只有具体描述
  const text = "一整排人替一个被杀死的婴儿论证死了是解脱";
  const r = taste.scoreFor(d, text);
  assert.ok(r.score < 0, `应该靠线索词命中，实际 ${r.score}`);
  assert.equal(r.hits[0].via, "cue", "应该标记为线索命中");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("字面命中标 literal", async () => {
  const d = mkDir();
  taste.touch(d, "凶案", { side: "owner", delta: -1 });
  const r = taste.scoreFor(d, "一条凶案视频");
  assert.equal(r.hits[0].via, "literal");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("无关内容不会被线索词误伤", async () => {
  const d = mkDir();
  taste.touch(d, "凶案", { side: "owner", delta: -1 });
  const r = taste.scoreFor(d, "今天天气不错，去公园散步，看到一只猫");
  assert.equal(r.score, 0, `误伤了：${JSON.stringify(r.hits)}`);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[3] 口味简报（进她的提示词）");
await ta("有档案时给出可读说明", async () => {
  const d = mkDir();
  taste.touch(d, "时政", { side: "owner", delta: -1 });
  taste.touch(d, "猫咪", { side: "mine", delta: 1 });
  const b = taste.brief(d);
  assert.ok(b.includes("口味"), b);
  assert.ok(b.includes("时政") || b.includes("猫咪"));
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("空档案 → 空字符串（不占上下文）", async () => {
  const d = mkDir();
  assert.equal(taste.brief(d), "");
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[4] 语义解析：模型输出要能收敛");
await ta("标准 JSON → 正确解析", () => {
  const r = feedback.parse('{"sentiment":"dislike","traits":["时政","凶案"],"note":"他不想看这类"}');
  assert.equal(r.ok, true);
  assert.equal(r.sentiment, "dislike");
  assert.deepEqual(r.traits, ["时政", "凶案"]);
});
await ta("带 markdown 围栏也能解析", () => {
  const r = feedback.parse('```json\n{"sentiment":"like","traits":["猫咪"],"note":"喜欢"}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.sentiment, "like");
});
await ta("模型多说废话也能捞出 JSON", () => {
  const r = feedback.parse('好的，我的判断是：{"sentiment":"dislike","traits":["带货"],"note":"反感带货"} 以上就是我的看法。');
  assert.equal(r.ok, true);
  assert.equal(r.sentiment, "dislike");
});
await ta("非法 sentiment → 拒绝", () => {
  const r = feedback.parse('{"sentiment":"hate","traits":["x"],"note":""}');
  assert.equal(r.ok, false);
});
await ta("traits 超过 3 个 → 截断", () => {
  const r = feedback.parse('{"sentiment":"like","traits":["a","b","c","d","e"],"note":""}');
  assert.equal(r.traits.length, 3);
});
await ta("主题词过长 → 丢弃", () => {
  const r = feedback.parse('{"sentiment":"like","traits":["这是一个非常非常长的主题词超过八个字"],"note":""}');
  assert.equal(r.traits.length, 0);
});
await ta("traits 去重", () => {
  const r = feedback.parse('{"sentiment":"like","traits":["猫","猫","狗"],"note":""}');
  assert.deepEqual(r.traits, ["猫", "狗"]);
});
await ta("confidence 默认 medium", () => {
  const r = feedback.parse('{"sentiment":"dislike","traits":["凶案"]}');
  assert.equal(r.confidence, "medium");
});
await ta("非法 confidence → 回退 medium", () => {
  const r = feedback.parse('{"sentiment":"dislike","traits":["x"],"confidence":"super"}');
  assert.equal(r.confidence, "medium");
});

console.log("\n[5] 落地：解析结果进档案");
await ta("dislike 让对应主题变负", async () => {
  const d = mkDir();
  const fb = feedback.parse('{"sentiment":"dislike","traits":["时政"],"note":"不想看"}');
  const r = feedback.apply(d, "owner", fb);
  assert.equal(r.ok, true);
  assert.equal(r.applied, 1);
  const s = taste.snapshot(d);
  const row = s.rows.find((x) => x.trait === "时政");
  assert.ok(row.owner < 0);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("neutral 不动档案", async () => {
  const d = mkDir();
  const fb = feedback.parse('{"sentiment":"neutral","traits":[],"note":"寒暄"}');
  const r = feedback.apply(d, "owner", fb);
  assert.equal(r.applied, 0);
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("confidence=low → 只观察，不动权重", async () => {
  const d = mkDir();
  const fb = feedback.parse('{"sentiment":"dislike","traits":["凶案"],"confidence":"low","note":"猜的"}');
  const r = feedback.apply(d, "owner", fb);
  assert.equal(r.applied, 0, "低置信度不该改权重");
  assert.ok(r.reason.includes("置信度低"), r.reason);
  const s = taste.snapshot(d);
  assert.equal(s.rows.length, 0, "档案不该被动");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("confidence=medium → 正常落档", async () => {
  const d = mkDir();
  const fb = feedback.parse('{"sentiment":"dislike","traits":["凶案"],"confidence":"medium","note":"上下文推的"}');
  const r = feedback.apply(d, "owner", fb);
  assert.equal(r.applied, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log("\n[6] 整条链：一句话 → 理解 → 落档");
await ta("注入假 thinker，'我一般不怎么看这类视频' 读成 dislike", async () => {
  const d = mkDir();
  const r = await feedback.digest({}, d, {
    text: "我一般不怎么看这类视频）",
    context: "她刚推了一条凶案视频",
    thinker: async () => '{"sentiment":"dislike","traits":["凶案"],"confidence":"medium","note":"委婉拒绝这类"}',
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.understood.sentiment, "dislike");
  const s = taste.snapshot(d);
  const row = s.rows.find((x) => x.trait === "凶案");
  assert.ok(row && row.owner < 0, "凶案应该被记成负");
  fs.rmSync(d, { recursive: true, force: true });
});
await ta("提示词改成闭合选项（不是开放猜测）", () => {
  const src = fs.readFileSync(path.join(APP, "lib/feedback.js"), "utf8");
  assert.ok(src.includes("候选主题词"), "没给候选词");
  assert.ok(src.includes("只能从这里面选"), "没限定选择范围");
  assert.ok(src.includes("confidence"), "没要求置信度");
});
await ta("有候选主题词时能抽出", () => {
  const src = fs.readFileSync(path.join(APP, "lib/feedback.js"), "utf8");
  assert.ok(src.includes("export function candidatesFrom"), "没有候选词抽取");
});
await ta("模型胡诌 → 不崩，报错", async () => {
  const d = mkDir();
  const r = await feedback.digest({}, d, {
    text: "在吗",
    thinker: async () => "我觉得他应该是喜欢的吧",
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("JSON"));
  fs.rmSync(d, { recursive: true, force: true });
});
console.log("\n[7] 接线：口味真的会影响分享与提示词");
t("share.js 排序用了口味", () => {
  const src = fs.readFileSync(path.join(APP, "lib/share.js"), "utf8");
  assert.ok(src.includes("taste.scoreFor"), "分享没看口味");
  assert.ok(src.includes("tasteScore"), "没把口味分算进权重");
});
t("口味太负的直接不推", () => {
  const src = fs.readFileSync(path.join(APP, "lib/share.js"), "utf8");
  assert.ok(src.includes("tasteScore > -0.5"), "没有负口味过滤");
});
t("wake.js 的 prompt 带上口味简报", () => {
  const src = fs.readFileSync(path.join(APP, "lib/wake.js"), "utf8");
  assert.ok(src.includes("taste.brief"), "提示词里没有口味");
});
t("收件箱轮询会自动读反馈", () => {
  const src = fs.readFileSync(path.join(APP, "lib/register-tasks.js"), "utf8");
  assert.ok(src.includes("feedback.digest"), "收到消息不读反馈，口味永远不变");
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
