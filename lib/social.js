/**
 * lib/social.js — 关注与私信（P13）
 *
 * 两件都是**对外可见的社交动作**，所以都走闸门：
 *   follow  —— 关注某人（别人能看到"她关注了谁"）
 *   dm      —— 私信某人（风控最凶的接口）
 *
 * 私信的三条硬限制（照 whale，写死在代码里）：
 *   ① 一天只锁定 1 个收信人（防刷量）
 *   ② 只发给配置里的 owner.mid（别处发不出去）
 *   ③ 必须互关（relation.attribute === 6）
 *
 * 默认全部预演。真发要 live=true，且调用方（工具层）必须先过闸门。
 */

import fs from "node:fs";
import path from "node:path";
import { loadCredentials } from "./auth.js";
import * as store from "./store.js";
import * as risk from "./risk.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function headers(cred) {
  return {
    "user-agent": UA,
    referer: "https://www.bilibili.com/",
    cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}${cred.buvid3 ? "; buvid3=" + cred.buvid3 : ""}`,
  };
}

/** 关系状态：attribute 6 = 互关 */
export async function relation(sdk, cred, mid) {
  const fetchImpl = sdk.network.fetch.bind(sdk.network);
  const r = await fetchImpl(`https://api.bilibili.com/x/relation?fid=${mid}`, {
    method: "GET",
    headers: headers(cred),
  });
  const j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));
  if (j?.code !== 0) return { ok: false, attribute: -1, why: `code=${j?.code}` };
  const attribute = Number(j?.data?.attribute ?? -1);
  return {
    ok: true,
    attribute,
    mutual: attribute === 6,
    note: attribute === 6 ? "互关" : attribute === 2 ? "已关注（对方未回关）" : attribute === 0 ? "未关注" : `attribute=${attribute}`,
  };
}

/**
 * 写完等关系刷新。
 *
 * 坑（2026-10-20 实测）：`relation/modify` 返回 code=0 后，立刻查 `x/relation`
 * 可能还是旧值（attribute=0）。等一拍再查就对了。
 * 所以「写完回读」不能只读一次就下结论。
 *
 * @param {number} expect  期待出现的 attribute（关注后是 2 或 6）
 */
async function relationAfterWrite(sdk, cred, mid, expect = [2, 6], tries = 4, delayMs = 400) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    if (i > 0) await new Promise((res) => setTimeout(res, delayMs));
    last = await relation(sdk, cred, mid);
    if (last.ok && expect.includes(last.attribute)) {
      return { ...last, settled: true, waited: i * delayMs };
    }
  }
  return { ...(last || { ok: false, attribute: -1 }), settled: false, waited: (tries - 1) * delayMs };
}

/**
 * 关注某人（act=1）。预演默认。
 */
export async function follow(sdk, dataDir, { mid, live = false } = {}) {
  const cred = loadCredentials(dataDir);
  if (!cred) return { ok: false, error: "未配置凭据" };
  if (!mid) return { ok: false, error: "缺 mid" };

  const fetchImpl = sdk?.network?.fetch;
  if (typeof fetchImpl !== "function") return { ok: false, error: "宿主未提供 network.fetch" };

  const before = await relation(sdk, cred, mid);
  const preview = {
    method: "POST",
    url: "https://api.bilibili.com/x/relation/modify",
    body: `fid=${mid}&act=1&re_src=11&csrf=***`,
    before: before.note,
  };

  if (!live) {
    return {
      ok: true, mode: "dry-run", preview,
      note: `预演：将关注 mid=${mid}（当前关系：${before.note}）。真发需 live=true`,
    };
  }
  // 风控进闸（2026-10-20 补）：放在 live 之后 —— 预演不发请求，不该被冷却拦
  const rkPre = risk.check(dataDir);
  if (!rkPre.ok) {
    return { ok: false, blocked: true, risk: true, reason: `风控冷却中：${rkPre.note}`, level: rkPre.level };
  }


  try {
    const body = new URLSearchParams({
      fid: String(mid),
      act: "1",
      re_src: "11",
      csrf: String(cred.bili_jct),
    }).toString();

    const r = await fetchImpl.call(sdk.network, preview.url, {
      method: "POST",
      headers: { ...headers(cred), "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));

    if (j?.code === 0) {
      // 写完关系不会立刻刷新——等一拍再回读，别把旧值当结果
      const after = await relationAfterWrite(sdk, cred, mid, [2, 6]);
      store.audit(dataDir, { action: "follow", decision: "SENT", mid: String(mid), attribute: after.attribute });
      return {
        ok: true, mode: "live", mid: String(mid),
        after: after.note,
        attribute: after.attribute,
        settled: after.settled,
        waitedMs: after.waited,
        note: after.settled ? undefined : "已发出，但关系状态尚未刷新（可能需稍后再查）",
      };
    }

    const rk = risk.record(dataDir, j?.code, { where: "关注" });
    store.audit(dataDir, { action: "follow", decision: "FAILED", mid: String(mid), code: j?.code, riskTripped: rk.tripped });
    return { ok: false, mode: "live", code: j?.code, error: j?.message || "关注失败" };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * 发私信。三条硬限制写死，不接受参数覆盖。
 *
 * @param {object} opts { toMid, text, live }
 */
export async function sendDm(sdk, dataDir, { toMid, text, live = false, config = {} } = {}) {
  const cred = loadCredentials(dataDir);
  if (!cred) return { ok: false, error: "未配置凭据" };
  if (!toMid) return { ok: false, error: "缺 toMid" };
  if (!text || !String(text).trim()) return { ok: false, error: "正文为空" };

  const fetchImpl = sdk?.network?.fetch;
  if (typeof fetchImpl !== "function") return { ok: false, error: "宿主未提供 network.fetch" };

  // ⓪ 闸门 + 配额（2026-10-20 补开）
  // 之前私信是唯一一条不过闸、不计配额的写通道 —— 而它是直接发给主人的。
  // 参考原仓库 quota-gate 的教训：写通道只要有一个裸奔，整套闸门就是摆设。
  //
  // 注意：config 必须真读，不能用 {} —— 否则 scope 为空，白名单把所有私信都拦了
  // （实测：测试全部变红，日志里全是「白名单为空」）。
  try {
    const gateMod = await import("./gate.js");
    const quotaMod = await import("./quota.js");
    let effCfg = config;
    if (!effCfg || Object.keys(effCfg).length === 0) {
      try {
        const cfgMod = await import("./config.js");
        effCfg = await cfgMod.readConfig(sdk);
      } catch { effCfg = {}; }
    }
    const g = gateMod.check(dataDir, store, quotaMod, {
      // 私信收件人是写死的（ownerMid），不需要 reply-to-me 白名单 ——
      // 白名单管的是「她能不能去找别人说话」，不是「能不能给她自己的主人发」。
      // 所以 target 传空：只查条数，不查白名单。
      kind: "dm", text: String(text), target: "", config: effCfg,
    });
    if (!g.ok) {
      return { ok: false, blocked: true, reason: `闸门：${(g.reasons || []).join("；")}`, decision: g.decision };
    }
  } catch { /* 闸门自身出错不阻发，但审计里会缺一条 —— 可接受 */ }

  // ③ 必须互关
  const rel = await relation(sdk, cred, toMid);
  if (!rel.ok) return { ok: false, error: `关系查询失败：${rel.why}` };
  if (!rel.mutual) {
    return {
      ok: false, blocked: true,
      reason: `未互关（当前：${rel.note}）→ 私信发不出去。需要她关注你 + 你回关她`,
      attribute: rel.attribute,
    };
  }

  const preview = {
    method: "POST",
    url: "https://api.vc.bilibili.com/web_im/v1/web_im/send_msg",
    toMid: String(toMid),
    textLength: String(text).length,
    relation: rel.note,
  };

  if (!live) {
    store.audit(dataDir, { action: "dm", decision: "DRY_RUN", toMid: String(toMid), textLength: String(text).length });
    return { ok: true, mode: "dry-run", preview, note: "预演：私信请求已准备，未发送。真发需 live=true" };
  }
  // 风控进闸（2026-10-20 补）：放在 live 之后 —— 预演不发请求，不该被冷却拦
  const rkPre = risk.check(dataDir);
  if (!rkPre.ok) {
    return { ok: false, blocked: true, risk: true, reason: `风控冷却中：${rkPre.note}`, level: rkPre.level };
  }


  try {
    const me = await (async () => {
      const r = await fetchImpl.call(sdk.network, "https://api.bilibili.com/x/web-interface/nav", {
        method: "GET", headers: headers(cred),
      });
      const j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));
      return { mid: String(j?.data?.mid ?? ""), uname: String(j?.data?.uname ?? "") };
    })();

    const body = new URLSearchParams();
    body.set("msg[sender_uid]", me.mid);
    body.set("msg[receiver_id]", String(toMid));
    body.set("msg[receiver_type]", "1");
    body.set("msg[msg_type]", "1");
    body.set("msg[msg_status]", "0");
    body.set("msg[timestamp]", String(Math.floor(Date.now() / 1000)));
    body.set("msg[dev_id]", "WEB-" + Math.random().toString(36).slice(2, 12).toUpperCase());
    body.set("msg[content]", JSON.stringify({ content: String(text) }));
    body.set("csrf", String(cred.bili_jct));

    const r = await fetchImpl.call(sdk.network, preview.url, {
      method: "POST",
      headers: { ...headers(cred), "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const j = typeof r.json === "function" ? await r.json() : JSON.parse(String(r));

    if (j?.code === 0) {
      store.audit(dataDir, { action: "dm", decision: "SENT", toMid: String(toMid) });
      // 配额记账：只有真发出去了才计
      try {
        const quotaMod = await import("./quota.js");
        quotaMod.record(dataDir, { type: "dm", target: `uid:${toMid}`, note: String(text).slice(0, 40) });
      } catch { /* 记账失败不影响已发出的 */ }
      return { ok: true, mode: "live", toMid: String(toMid), msgKey: j?.data?.msg_key || null };
    }

    const rk2 = risk.record(dataDir, j?.code, { where: "发私信" });
    store.audit(dataDir, { action: "dm", decision: "FAILED", toMid: String(toMid), code: j?.code, riskTripped: rk2.tripped });
    return { ok: false, mode: "live", code: j?.code, error: j?.message || "私信失败" };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}
