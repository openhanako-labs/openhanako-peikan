// peikan 功能面板脚本（module）
import { hana } from "./sdk.js";

(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function readJson(res) {
    if (res && typeof res.text === "function") {
      return res.text().then(function (t) {
        try { return JSON.parse(t); } catch (e) { throw new Error("HTTP " + res.status); }
      });
    }
    return Promise.resolve(res);
  }
  function api(path) {
    return Promise.resolve(hana.api.fetch(path, {})).then(readJson);
  }

  var LABEL = { comment: "评论", dynamic: "动态", dm: "私信", follow: "关注", like: "点赞", share: "分享" };

  function renderQuota(q) {
    var box = $("quota");
    if (!box) return;
    var caps = (q && q.caps) || {};
    // 从数据里取所有类型，而不是写死四项 ——
    // 之前写死 [comment, dynamic, dm, share]，结果 follow 和 like 永远不显示，
    // 外面看就是「计数没更新」，实际是根本没渲染。
    var keys = Object.keys(LABEL).filter(function (k) { return caps[k]; });
    box.innerHTML = keys.map(function (k) {
      var c = caps[k] || { used: 0, cap: 0 };
      var pct = c.cap > 0 ? Math.round((c.used / c.cap) * 100) : 0;
      return '<div class="qcell"><div class="ql">' + LABEL[k] + '</div>' +
        '<div class="qv">' + c.used + '<small>/' + c.cap + '</small></div>' +
        '<div class="tr"><i style="width:' + pct + '%"></i></div></div>';
    }).join("");
  }

  function normalizeTitle(t) {
    var s = String(t || "").trim();
    s = s.replace(/《{2,}/g, "《").replace(/》{2,}/g, "》");
    var guard = 0;
    while (guard++ < 4 && s.startsWith("《") && s.endsWith("》")) {
      var inner = s.slice(1, -1);
      if (inner.indexOf("《") >= 0 || inner.indexOf("》") >= 0) s = inner.trim();
      else break;
    }
    var o = (s.match(/《/g) || []).length;
    var c2 = (s.match(/》/g) || []).length;
    if (o !== c2) s = s.replace(/[《》]/g, "");
    return s;
  }

  function renderRecent(items) {
    var box = $("recent");
    if (!box) return;
    var top = (items || []).slice(0, 4);
    if (!top.length) {
      box.innerHTML = '<div class="m"><div class="mc"><div class="mt" style="color:var(--ink-3)">还没有笔记</div></div></div>';
      return;
    }
    box.innerHTML = top.map(function (n) {
      var raw = String(n.summary || "");
      var m = /^\[(\d+)\/20/.exec(raw);
      var score = m ? Number(m[1]) : null;
      var body = raw.replace(/^\[\d+\/20[^\]]*\]\s*/, "");

      var main = body, tail = "";
      var mp = body.indexOf("｜");
      if (mp >= 0) { main = body.slice(0, mp); tail = body.slice(mp + 1); }

      var seg = main.split(" · ");
      var title = normalizeTitle(seg[0] || "");
      var meta = seg.slice(1).join(" · ");
      if (tail && !/^\d+s 处/.test(tail)) {
        meta = (meta ? meta + " · " : "") + tail.replace(/^热评[：:]/, "热评 ");
      }

      return '<div class="m">' +
        '<span class="ms' + (score !== null && score >= 13 ? " pass" : "") + '">' +
        (score !== null ? score : "–") + '</span>' +
        '<div class="mc"><div class="mt">' + esc(title) + '</div>' +
        (meta ? '<div class="mm">' + esc(meta) + '</div>' : "") +
        '</div></div>';
    }).join("");
  }

  function load() {
    api("/health").then(function (h) {
      var configured = h && h.credentialsConfigured;
      $("live-text").textContent = configured ? "已接入" : "未接入";
      $("dot").className = configured ? "" : "bad";
      $("k-notes").textContent = (h && typeof h.notes === "number") ? h.notes : 0;
      $("v-review").textContent = (h && typeof h.review === "number") ? h.review : 0;
      $("v-post").textContent = (h && h.autoPostEnabled) ? "开" : "关";
      $("v-live").textContent = (h && h.publishLive) ? "真发" : "预演";
      renderQuota(h && h.quota);
    }).catch(function () {
      $("live-text").textContent = "未连接";
      $("dot").className = "bad";
    });

    api("/rhythm").then(function (r) {
      if (!r) return;
      var wk = Number(r.wakes || 0), capW = Number(r.maxWakesPerDay || 3);
      var mw = Number(r.manualWakes || 0);
      // 手动叫醒现在是另一个计数器：不占她的作息额度，就不再显示成 5/3
      $("v-wake").textContent = wk + " / " + capW + (mw > 0 ? "（手动 " + mw + "）" : "");
      // 超配额时把数字标红（.over）——旧状态里可能有历史超出的数据
      $("v-wake").className = "v" + (wk > capW ? " over" : "");
      var plan = r.plan || {};
      $("v-next").textContent = plan.atText || "—";
    }).catch(function () {});

    api("/notes").then(function (r) {
      var items = (r && r.items) || [];
      var pass = 0;
      items.forEach(function (x) {
        var m = /^\[(\d+)\/20/.exec(String(x.summary || ""));
        if (m && Number(m[1]) >= 13) pass++;
      });
      $("v-pass").textContent = pass;
      renderRecent(items);
    }).catch(function () {});
  }

  $("refresh").addEventListener("click", load);

  // 自动刷新：面板是常驻窄栏，不会因为数据变了就自己重载。
  // 之前只在打开时 load() 一次，所以「醒过 0/3」永远是打开那一刻的快照。
  // 30 秒一次，不重（成本只是一次轻请求）。
  setInterval(function () {
    // 页面藏着时不拉（省电，也避免无谓请求）
    if (document.hidden) return;
    load();
  }, 30 * 1000);

  // 切回来时立即刷一次
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) load();
  });

  var started = false;
  function startOnce() { if (started) return; started = true; load(); }
  try {
    hana.ready();
    if (hana.surface && typeof hana.surface.onContextChanged === "function") {
      hana.surface.onContextChanged(function (ctx) { if (ctx) startOnce(); });
    }
    setTimeout(startOnce, 600);
  } catch (e) { startOnce(); }
})();
