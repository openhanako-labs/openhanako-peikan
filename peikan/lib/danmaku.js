/**
 * lib/danmaku.js — 弹幕热区（P4.2）
 *
 * 弹幕是 B站 独有的信号：视频本身不会告诉你「哪里炸」，但观众会。
 * 这里不只数条数，而是算**注意力曲线**：
 *   · 按时间分桶（默认 10 秒一桶）统计密度
 *   · 找出密度最高的几段 = 高能时刻
 *   · 抽几条有信息量的弹幕（去重、去纯表情、去复读）
 *
 * 接口选 XML（x/v1/dm/list.so）：一次拿全，比 protobuf 分段省事。
 * 实测：267 秒的视频 830 条，71KB。
 */

const XML_URL = "https://api.bilibili.com/x/v1/dm/list.so";

/** 纯表情/纯符号/纯复读的弹幕没信息量，剔掉 */
function isLowValue(s) {
  const t = String(s || "").trim();
  if (!t) return true;
  if (t.length <= 2) return true;                    // 太短
  if (/^[哈h啊a8草c6yYwW\s!！?？.。~～、,，]+$/i.test(t)) return true;  // 纯语气
  if (/^\[[^\]]+\]$/.test(t)) return true;           // 纯表情代码
  return false;
}

/** 去掉「刷屏」：同一内容出现 ≥3 次只留一条 */
function dedupe(items) {
  const count = new Map();
  for (const it of items) count.set(it.text, (count.get(it.text) || 0) + 1);
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (seen.has(it.text)) continue;
    seen.add(it.text);
    out.push({ ...it, repeats: count.get(it.text) });
  }
  return out;
}

/**
 * 解析 XML 弹幕。
 * <d p="时间,模式,字号,颜色,时间戳,池,用户hash,行号">内容</d>
 */
export function parseXml(xml) {
  const items = [];
  const re = /<d p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1].split(",");
    const text = m[2]
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&amp;/g, "&")
      .trim();
    const t = Number(attrs[0]) || 0;
    if (t >= 0 && text) items.push({ t, text });
  }
  return items;
}

/**
 * 按时间分桶，算密度曲线。
 * @returns {Array<{from,to,count,rate}>}
 */
export function densityCurve(items, duration, bucketSec = 10) {
  if (!duration || duration <= 0) return [];
  const n = Math.max(1, Math.ceil(duration / bucketSec));
  const buckets = Array.from({ length: n }, (_, i) => ({
    from: i * bucketSec,
    to: Math.min((i + 1) * bucketSec, duration),
    count: 0,
  }));
  for (const it of items) {
    const idx = Math.min(n - 1, Math.floor(it.t / bucketSec));
    if (idx >= 0) buckets[idx].count++;
  }
  const peak = Math.max(1, ...buckets.map((b) => b.count));
  return buckets.map((b) => ({ ...b, rate: b.count / peak }));
}

/**
 * 找高能时刻：密度最高的若干桶，且密度必须超过均值倍数。
 */
export function hotMoments(items, duration, { bucketSec = 10, top = 3, minMultiple = 2 } = {}) {
  const curve = densityCurve(items, duration, bucketSec);
  if (!curve.length) return [];
  const avg = curve.reduce((s, b) => s + b.count, 0) / curve.length;
  const threshold = Math.max(3, avg * minMultiple);
  return curve
    .filter((b) => b.count >= threshold)
    .sort((a, b) => b.count - a.count)
    .slice(0, top)
    .map((b) => {
      // 抽这一桶里最有信息量的两条
      const inBucket = items.filter((it) => it.t >= b.from && it.t < b.to && !isLowValue(it.text));
      const picked = dedupe(inBucket).sort((x, y) => (y.repeats || 0) - (x.repeats || 0)).slice(0, 2);
      return {
        at: b.from,
        to: b.to,
        count: b.count,
        samples: picked.map((p) => p.text.slice(0, 40)),
      };
    });
}

/**
 * 拉一条视频的弹幕并分析。
 * @param {object} sdk
 * @param {string} dataDir
 * @param {object} opts { cid, duration, bucketSec, top }
 */
export async function analyze(sdk, dataDir, { cid = 0, duration = 0, bucketSec = 10, top = 3 } = {}) {
  if (!cid) return { ok: false, note: "缺 cid" };
  try {
    const fetchImpl = sdk.network.fetch.bind(sdk.network);
    // 弹幕接口不收 cookie 也行，但带上更稳
    const res = await fetchImpl(`${XML_URL}?oid=${cid}`, {
      method: "GET",
      headers: { "user-agent": "Mozilla/5.0", referer: "https://www.bilibili.com/" },
    });
    const xml = typeof res.text === "function" ? await res.text() : String(res);
    if (!xml || xml.length < 100) return { ok: false, note: "弹幕响应为空" };

    const items = parseXml(xml);
    if (!items.length) return { ok: false, note: "没有弹幕" };

    const dur = Number(duration) || Math.max(...items.map((x) => x.t));
    const curve = densityCurve(items, dur, bucketSec);
    const hot = hotMoments(items, dur, { bucketSec, top });
    const avg = curve.length ? curve.reduce((s, b) => s + b.count, 0) / curve.length : 0;

    return {
      ok: true,
      total: items.length,
      duration: dur,
      avgPerBucket: Math.round(avg * 10) / 10,
      bucketSec,
      hotMoments: hot,
      curve: curve.map((b) => ({ at: b.from, n: b.count })),  // 精简给模型看
      note: `${items.length} 条弹幕，${bucketSec}s 一桶，均值 ${Math.round(avg * 10) / 10}/桶`,
    };
  } catch (e) {
    return { ok: false, note: `弹幕失败：${e && e.message ? e.message : e}` };
  }
}
