// peikan 工作室脚本（module）——只走 hana.api.fetch
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
  // 图片地址必须走 hana.api.url ——
  //
  // 坑（2026-10-20 真机）：卡片 iframe 的地址是 /api/apps/<id>/ui/xxx.html，
  // 所以 <img src="./avatar"> 会被解析成 /api/apps/<id>/ui/avatar（404），
  // 而不是路由 /api/apps/<id>/routes/avatar。
  // hana.api.url("/avatar") 才会给出正确的 routes 前缀。
  function apiUrl(p) {
    try {
      return hana.api.url(p);
    } catch (e) {
      return p;   // 兜底（harness 里没有 hana.api.url 时）
    }
  }

  /**
   * 把路由返回的图片塞进 <img>。
   *
   * 为什么不能直接写 src：卡片 iframe 的 origin 是 file://（真机实测），
   * <img src="/api/apps/..."> 会被服务器 403。
   * 只有 hana.api.fetch 带得上会话，取回 blob 再造 objectURL。
   */
  function loadImageInto(img, apiPath) {
    if (!img || !apiPath) return;
    Promise.resolve(hana.api.fetch(apiPath, {}))
      .then(function (res) {
        if (!res || res.ok === false) throw new Error("fetch fail");
        return res.blob();
      })
      .then(function (blob) {
        if (!blob || !blob.size) throw new Error("empty");
        img.src = URL.createObjectURL(blob);
        img.dataset.loaded = "1";
      })
      .catch(function () {
        // 图没了就把整块隐藏，不占位
        if (img.parentNode) img.parentNode.style.display = "none";
      });
  }

  function api(path, opts) {
    return Promise.resolve(hana.api.fetch(path, opts || {})).then(readJson);
  }
  function ts(iso) {
    if (!iso) return "—";
    try {
      // 2026-10-20：日记标题现在是人读格式（"2026-10-20 19:52"），
      // 直接 new Date() 在 Chrome 里得到 Invalid Date（缺 T 分隔）。
      // 这里先把常见的几种都转成可解析的。
      var s = String(iso).trim();
      var d = new Date(s);
      if (isNaN(d.getTime())) {
        // "2026-10-20 19:52" → "2026-10-20T19:52:00"
        var m = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})/);
        if (m) d = new Date(m[1] + "T" + String(m[2]).padStart(2, "0") + ":" + m[3] + ":00");
      }
      if (isNaN(d.getTime())) return s;   // 还是不行就原样显示，不写 Invalid Date
      return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch (e) { return String(iso); }
  }
  function hhmm(iso) {
    if (!iso) return "—";
    try {
      var d = new Date(iso);
      return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    } catch (e) { return "—"; }
  }

  var TITLES = {
    notes: ["笔记本", "Observation notes"],
    rhythm: ["作息", "Rhythm"],
    inbox: ["互动", "Interactions"],
    learned: ["学到", "Learned"],
    drafts: ["草稿箱", "Drafts"],
    review: ["待拍板", "Review queue"],
    diary: ["日记", "Diary"],
    ledger: ["账本", "Ledger"],
    setup: ["接入", "Setup"],
    settings: ["设置", "Settings"],
  };

  // ── 导航 ────────────────────────────────────────────────
  var navEl = $("nav");
  var panels = document.querySelectorAll("section.panel");

  // ── 新手引导 ──
  //
  // 修了三次才定：
  //   ① 一开始「先显示再判断」→ 闪一下（1.2s）
  //   ② 后来改「等列表渲染再判」→ 数据没回来的瞬间判，反复闪
  //   ③ 现在：状态存在 config.json（服务端），不靠 localStorage
  //
  // 为什么必须存服务端：Hana 的 App 卡片是 iframe，每次重载都是新的存储上下文，
  // localStorage 存不住。所以「点过 × 就不再出现」这件事，之前从来没生效过。
  (function initOnboarding() {
    var ob = $("onboarding");
    if (!ob) return;
    ob.hidden = true;           // 默认藏，只有确认该显示才显示

    var decided = false;
    function decide(cfg) {
      if (decided) return;
      decided = true;
      var dismissed = Boolean(cfg && cfg.onboardDismissed);
      if (dismissed) { ob.hidden = true; return; }
      // 只在「真的什么都没有」时出现：
      //   没配置登录态，且一条笔记都没有
      var hasCred = Boolean(cfg && cfg.__hasCred);
      var n = document.getElementById("hero-notes");
      var count = n ? Number(n.textContent || "0") : 0;
      ob.hidden = !(count === 0 && !hasCred);
    }

    // 一次拿齐：配置 + 登录态
    Promise.all([
      api("/config").catch(function () { return null; }),
      api("/health").catch(function () { return null; }),
    ]).then(function (arr) {
      var cfg = (arr[0] && arr[0].config) || {};
      var health = arr[1] || {};
      cfg.__hasCred = health.credentialsConfigured === true;
      // 笔记数从 health 拿更准（hero-notes 可能还没渲染）
      if (typeof health.notes === "number") {
        ob.hidden = !(health.notes === 0 && !cfg.__hasCred);
        decided = true;
        return;
      }
      decide(cfg);
    }).catch(function () {
      if (!decided) { decided = true; ob.hidden = true; }
    });

    var x = $("ob-close");
    if (x) {
      x.addEventListener("click", function () {
        ob.hidden = true;
        // 写服务端 —— 这是唯一能跨重载存住的地方
        api("/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ onboardDismissed: true }),
        }).catch(function () { /* 忽略 */ });
      });
    }
  })();

  function switchTab(tab) {
    if (!TITLES[tab]) return;
    navEl.querySelectorAll("a[data-tab]").forEach(function (a) {
      a.classList.toggle("on", a.getAttribute("data-tab") === tab);
    });
    panels.forEach(function (p) {
      p.setAttribute("data-active", String(p.getAttribute("data-panel") === tab));
    });
    var t = $("page-title"), s = $("page-sub");
    if (t) t.textContent = TITLES[tab][0];
    if (s) s.textContent = TITLES[tab][1];
    var body = $("body");
    if (body) body.scrollTop = 0;
  }

  navEl.querySelectorAll("a[data-tab]").forEach(function (a) {
    a.addEventListener("click", function () { switchTab(a.getAttribute("data-tab")); });
  });

  // ── 顶栏 ────────────────────────────────────────────────
  function renderHealth(h) {
    var configured = h && h.credentialsConfigured;
    // 副标题由 switchTab 管理，这里不动
    $("mode-text").className = configured ? "" : "bad";
    $("mode-text").textContent = (h && h.autoPostEnabled) ? "可发布" : "只读";

    if (h && typeof h.notes === "number") {
      $("hero-notes").textContent = h.notes;
    }
    if (h) {
      // hero-wake 由 loadRhythm 填
      var caps = (h.quota && h.quota.caps) || {};
      var c = caps.comment || {};
      var s = caps.share || {};
      $("hero-say").innerHTML = (c.used || 0) + "<em>/" + (c.cap || 0) + "</em>";
      renderQuota(h.quota);
    }
    if (h && typeof h.review === "number") {
    }
  }

  // ── 互动页 ────────────────────────────────────────
  // 2026-10-20 重做：之前是把数据倒进容器（一行字里塞三个 scope、200px 虚线框里一句话），
  // 现在按「左侧小标 + 主内容」的骨格重排，每一项都是一条可扫的记录。
  function loadDigest(hours) {
    var st = $("digest-status");
    if (st) st.textContent = "拉取中";
    api("/digest?hours=" + (hours || 24)).then(function (r) {
      var list = $("digest-list");
      if (!list) return;
      var items = (r && r.items) || [];
      list.innerHTML = "";
      $("digest-empty").hidden = items.length > 0;
      items.slice().reverse().forEach(function (x) {
        var at = x.at ? new Date(x.at * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
        var li = document.createElement("li");
        var kindLabel = x.kind === "@我" ? "AT" : (x.kind === "私信" || x.kind === "dm" ? "DM" : "RE");
        li.innerHTML =
          '<div class="k">' + esc(kindLabel) + '</div>' +
          '<div class="v">' +
            '<div class="t">' + esc(x.who || "?") + '</div>' +
            '<div class="m">' + esc(at) + '</div>' +
            '<div class="b">' + esc(String(x.body || "（读不到正文）").slice(0, 220)) + '</div>' +
          '</div>';
        list.appendChild(li);
      });
      if (st) st.textContent = items.length ? items.length + " 条" : "";
    }).catch(function (e) {
      if (st) st.textContent = "失败：" + (e && e.message || e);
    });
  }

  function loadAllowlist() {
    api("/allowlist").then(function (r) {
      var host = $("allow-list");
      if (!host) return;
      host.innerHTML = "";

      var statics = (r && (r.static || r.scope)) || [];
      var dyn = (r && r.dynamic) || {};
      var dynList = dyn.list || [];

      function row(k, v, note) {
        return '<div class="row"><div class="k">' + esc(k) + '</div>' +
          '<div class="v">' + esc(v) + (note ? '<em>' + esc(note) + '</em>' : '') + '</div></div>';
      }

      if (!statics.length) {
        host.innerHTML += row("固定", "空", "谁都不允许");
      } else {
        statics.forEach(function (s) {
          var label = String(s);
          var note = "";
          if (label === "reply-to-me") note = "找过她的人";
          else if (label.indexOf("uid:") === 0) note = "指定用户";
          else if (label.indexOf("BV:") === 0) note = "指定视频";
          host.innerHTML += row("固定", label, note);
        });
      }

      if (dynList.length) {
        dynList.slice(0, 8).forEach(function (p) {
          host.innerHTML += row("找过", (p.name || p.uid || p.mid || "?") + "", "已记下");
        });
        if (dynList.length > 8) {
          host.innerHTML += row("", "还有 " + (dynList.length - 8) + " 人", "");
        }
      } else {
        host.innerHTML += row("找过", "还没人找过她", "");
      }
    }).catch(function () { /* 忽略 */ });
  }

  // ── 学到页 ────────────────────────────────────────
  function loadTaste() {
    api("/taste").then(function (r) {
      var kv = $("taste-kv");
      var list = $("taste-list");
      if (!list) return;
      var traits = (r && (r.traits || r.items)) || [];

      if (kv) {
        var neg = traits.filter(function (t) { return (t.mine || 0) < 0 || (t.owner || 0) < 0; }).length;
        kv.innerHTML =
          '<div class="it"><span class="v">' + traits.length + '</span><span class="l">偏好项</span></div>' +
          '<div class="it"><span class="v">' + neg + '</span><span class="l">不看的</span></div>';
      }

      list.innerHTML = "";
      $("taste-empty").hidden = traits.length > 0;

      traits.slice(0, 30).forEach(function (t) {
        var mine = Number(t.mine || 0), owner = Number(t.owner || 0);
        var both = mine !== 0 && owner !== 0;
        var eff = both ? mine * 0.7 + owner * 0.3 : (mine || owner);
        var clamped = Math.max(-1, Math.min(1, eff));
        var w = Math.abs(clamped) * 50;
        var left = clamped >= 0 ? 50 : 50 - w;
        var color = clamped >= 0 ? "var(--copper)" : "var(--ink-3)";

        var li = document.createElement("li");
        li.className = "taste-row";
        li.innerHTML =
          '<div class="nm">' + esc(t.trait || t.name || "?") + '<em>' + (both ? "你+她" : (mine ? "她" : "你")) + '</em></div>' +
          '<div class="track">' +
            '<div class="mid"></div>' +
            '<i style="left:' + left + '%;width:' + w + '%;background:' + color + '"></i>' +
          '</div>' +
          '<div class="val">' + (eff > 0 ? "+" : "") + eff.toFixed(2) + '</div>';
        list.appendChild(li);
      });
    }).catch(function () { /* 忽略 */ });

    api("/silence").then(function (r) {
      var kv = $("silence-kv");
      if (!kv) return;
      var stage = (r && (r.state || r.stage)) || "正常";
      var days = r && (r.daysSinceFeedback != null ? r.daysSinceFeedback : r.days);
      var q = r && (r.quota != null ? r.quota : r.shareQuota);
      kv.innerHTML =
        '<div class="it"><span class="v sm">' + esc(stage) + '</span><span class="l">状态</span></div>' +
        (days != null ? '<div class="it"><span class="v">' + days + '</span><span class="l">天没表态</span></div>' : '') +
        (q != null ? '<div class="it"><span class="v">' + q + '</span><span class="l">分享额度</span></div>' : '');
    }).catch(function () { /* 忽略 */ });

    api("/likes").then(function (r) {
      var list = $("likes-list");
      if (!list) return;
      var items = (r && r.items) || [];
      list.innerHTML = "";
      $("likes-empty").hidden = items.length > 0;
      items.slice(0, 20).forEach(function (x) {
        var li = document.createElement("li");
        li.innerHTML =
          '<div class="k">' + esc(x.kind || "赞") + '</div>' +
          '<div class="v"><div class="t">' + esc(x.title || x.bvid || x.mid || "?") + '</div>' +
          '<div class="m">' + esc(x.at ? new Date(x.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "") + '</div></div>';
        list.appendChild(li);
      });
    }).catch(function () { /* 忽略 */ });

    // 她看过什么
    api("/watch").then(function (r) {
      if (!r || !r.ok) return;
      var kv = $("watch-kv");
      var list = $("up-list");
      var note = $("watch-note");
      if (note) note.textContent = r.total ? r.total + " 条" : "";

      if (kv) {
        kv.innerHTML =
          '<div class="it"><span class="v">' + r.total + '</span><span class="l">一共笔记</span></div>' +
          '<div class="it"><span class="v">' + r.weekCount + '</span><span class="l">近 7 天</span></div>' +
          '<div class="it"><span class="v">' + r.totalHours + '</span><span class="l">小时</span></div>' +
          '<div class="it"><span class="v">' + r.avgMinutes + '</span><span class="l">分钟均长</span></div>';
      }

      if (list) {
        list.innerHTML = "";
        (r.topUps || []).forEach(function (u, i) {
          var d = document.createElement("div");
          d.className = "it";
          d.innerHTML =
            '<span class="n">' + u.count + '</span>' +
            '<span class="nm' + (i === 0 ? " hot" : "") + '">' + esc(u.name) + '</span>';
          list.appendChild(d);
        });
      }
    }).catch(function () { /* 忽略 */ });
  }

  // ── 账本：她发出去的 + 撤回 ──────────────────────────
  function loadSent() {
    api("/sent").then(function (r) {
      var list = $("sent-list");
      if (!list) return;
      var items = (r && r.items) || [];
      list.innerHTML = "";
      $("sent-empty").hidden = items.length > 0;
      items.forEach(function (x) {
        var li = document.createElement("li");
        var id = x.rpid || x.dynId || "";
        li.innerHTML =
          '<div class="k">' + esc(x.kind === "dynamic" ? "动态" : "评论") + '</div>' +
          '<div class="v" style="display:flex;align-items:flex-start;gap:12px">' +
            '<div style="flex:1 1 auto;min-width:0">' +
              '<div class="t">' + esc(x.target || x.bvid || "") + '</div>' +
              '<div class="m">' + esc(x.at ? new Date(x.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "") + '</div>' +
              (x.text ? '<div class="b">' + esc(String(x.text).slice(0, 80)) + '</div>' : '') +
            '</div>' +
            '<button class="btn js-retract" data-kind="' + esc(x.kind || "") + '" data-id="' + esc(id) + '" data-bv="' + esc(x.bvid || "") + '" style="flex:0 0 auto">撤回</button>' +
          '</div>';
        list.appendChild(li);
      });
    }).catch(function () { /* 忽略 */ });
  }

  // 撤回（两段确认：点一下真删，但要 publishLive 开着才生效）
  function bindRetract() {
    document.addEventListener("click", function (ev) {
      var btn = ev.target && ev.target.closest && ev.target.closest(".js-retract");
      if (!btn) return;
      var kind = btn.getAttribute("data-kind");
      var id = btn.getAttribute("data-id");
      var bv = btn.getAttribute("data-bv");
      if (!id) return;
      var payload = kind === "dynamic" ? { kind: "dynamic", dynId: id } : { kind: "comment", rpid: id, bvid: bv };
      payload.live = true;
      btn.disabled = true;
      btn.textContent = "删中";
      api("/retract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }).then(function (r) {
        btn.textContent = (r && r.ok) ? "已删" : "失败";
        if (r && r.ok) { setTimeout(function () { loadSent(); }, 600); }
        else { btn.disabled = false; btn.textContent = "撤回"; alert((r && (r.reason || r.error)) || "删不掉"); }
      }).catch(function (e) {
        btn.disabled = false;
        btn.textContent = "撤回";
        alert("失败：" + (e && e.message || e));
      });
    });
  }

  function loadHealth() {
    return api("/health").then(renderHealth).catch(function () {
      $("page-sub").textContent = "读取失败";
      $("mode-text").className = "bad";
    });
  }

  // ── 笔记本 ──────────────────────────────────────────────
  // 两种数据形态：
  //   新：[13/20·有字幕·有炸点] 《标题》 · UP xx · 22 万播放｜0s 处 83 条：全体起立
  //   旧：《标题》 · UP xx · 21 万播放｜热评：xxx   （无分数前缀）
  function normalizeTitle(t) {
    var s = String(t || "").trim();
    // 收敛相邻重复
    s = s.replace(/《{2,}/g, "《").replace(/》{2,}/g, "》");
    // 若整体被一个《》包住，而内部还有《 或 》，剥掉最外层
    var guard = 0;
    while (guard++ < 4 && s.startsWith("《") && s.endsWith("》")) {
      var inner = s.slice(1, -1);
      if (inner.indexOf("《") >= 0 || inner.indexOf("》") >= 0) {
        s = inner.trim();
      } else {
        break;
      }
    }
    // ③ 视觉避让：外层《 紧跟【 时会看成双括号 → 去掉外层
    if (/^《【/.test(s)) s = s.slice(1);
    // ④ 最终配对检查：数量不等时，去掉所有书名号
    var open = (s.match(/《/g) || []).length;
    var close = (s.match(/》/g) || []).length;
    if (open !== close) {
      s = s.replace(/[《》]/g, "").trim();
    }
    return s;
  }

  function parseNote(n) {
    var raw = String(n.summary || "");
    var score = null;
    var flags = [];
    var m = /^\[(\d+)\/20([^\]]*)\]\s*/.exec(raw);
    if (m) {
      score = Number(m[1]);
      flags = String(m[2] || "").split("·").map(function (x) { return x.trim(); }).filter(Boolean);
      raw = raw.slice(m[0].length);
    }

    var body = raw, tail = "";
    var mp = raw.indexOf("｜");
    if (mp >= 0) { body = raw.slice(0, mp); tail = raw.slice(mp + 1); }

    var title = body;
    var meta = [];
    var parts = body.split(" · ");
    if (parts.length) title = parts[0];
    for (var i = 1; i < parts.length; i++) meta.push(parts[i]);

    var quote = "", note = "";
    var qm = /^(\d+)s 处 (\d+) 条[：:](.+)$/.exec(tail);
    if (qm) {
      quote = qm[3];
      meta.push(qm[1] + "s 处 " + qm[2] + " 条弹幕");
    } else if (tail) {
      note = tail.replace(/^热评[：:]/, "");
    }

    // 书名号归一：
    //   ① 相连重复：《《 → 《
    //   ② 外层包裹内层：《《A》《B》x》 → 《A》《B》x（剥掉最外层）
    title = normalizeTitle(title);

    // 新数据结构（2026-10-20）：title 和 summary 分开存。
    // 旧数据只有 summary，那就保持旧渲染（title 从 summary 抽）。
    var hasTitle = typeof n.title === "string" && n.title.trim().length > 0;
    if (hasTitle) {
      return {
        score: score, flags: flags,
        title: n.title.trim(),
        body: note || quote || "",   // 新数据：整段 summary 就是判断
        summaryText: String(n.summary || ""),
        meta: meta, quote: "", note: "", isNew: true,
      };
    }

    return { score: score, flags: flags, title: title, meta: meta, note: note, quote: quote, isNew: false };
  }

  function loadNotes() {
    api("/notes").then(function (r) {
      var items = (r && r.items) || [];
      var list = $("notes-list");
      list.innerHTML = "";
      $("notes-empty").hidden = items.length > 0;

      var passCount = 0;
      items.forEach(function (n) {
        var p = parseNote(n);
        if (p.score !== null && p.score >= 13) passCount++;

        var scoreHtml = p.score !== null
          ? '<span class="n' + (p.score >= 13 ? " pass" : "") + '">' + p.score + '</span><span class="d">/20</span>'
          : '<span class="n" style="font-size:13px;color:var(--line-strong);opacity:.8;font-weight:400">·</span>';

        var metaText = [ts(n.at)].concat(p.meta).join(" · ");

    // 视频本身的时长/发布时间（不是笔记的写入时间）
    // 以前只显示笔记写入时刻，看不出「这条值不值得看」
    if (n.duration > 0) {
      var mm = Math.floor(n.duration / 60);
      var ss = Math.floor(n.duration % 60);
      metaText += (mm ? " · " + mm + " 分 " : " · ") + (mm ? (ss < 10 ? "0" + ss : ss) + " 秒" : ss + " 秒");
    }
    if (n.pubdate > 0) {
      var pd = new Date(n.pubdate * 1000);
      var today = new Date();
      var sameDay = pd.toDateString() === today.toDateString();
      metaText += " · " + (sameDay ? "今天发布" : (pd.getMonth() + 1) + "-" + pd.getDate() + " 发布");
    }

        var li = document.createElement("li");
        if (p.isNew) {
          // 新结构：标题是一句话，下面是她的判断（可以长）
          // 封面：source 是 BV 号才有图（本地缓存，不存在就 404 → 不显示）
          // /frame?kind=cover&bvid= 只认纯 BV 号（后端会加 .jpg）。
          // 优先用 n.bvid；没有才从 source 里抽。
          // 关键：只有 n.cover 非空（说明文件真的在）才渲染 img ——
          // 否则就是白白发一个 404 请求，然后靠 onerror 隐藏，白花一次网络。
          var bv1 = String(n.bvid || "").match(/BV[0-9A-Za-z]+/) || String(n.source || "").match(/BV[0-9A-Za-z]+/);
          var hasCover1 = Boolean(n.cover) && Boolean(bv1);
          var coverHtml = hasCover1
            ? '<div class="cover"><img data-cover="' + encodeURIComponent(bv1[0]) + '" alt="" /></div>'
            : "";
          li.innerHTML =
            coverHtml +
            '<div class="score">' + scoreHtml + '</div>' +
            '<div class="content"><h3>' + esc(p.title) + '</h3>' +
            '<div class="meta">' + esc(metaText) + '</div>' +
            (p.summaryText ? '<p class="note">' + inlineMd(p.summaryText) + '</p>' : "") +
            '</div>';
        } else {
          var bv2 = String(n.bvid || "").match(/BV[0-9A-Za-z]+/) || String(n.source || "").match(/BV[0-9A-Za-z]+/);
          var hasCover2 = Boolean(n.cover) && Boolean(bv2);
          var coverHtml2 = hasCover2
            ? '<div class="cover"><img data-cover="' + encodeURIComponent(bv2[0]) + '" alt="" /></div>'
            : "";
          li.innerHTML =
            coverHtml2 +
            '<div class="score">' + scoreHtml + '</div>' +
            '<div class="content"><h3>' + esc(p.title) + '</h3>' +
            '<div class="meta">' + esc(metaText) + '</div>' +
            (p.note ? '<p class="note">' + esc(p.note) + '</p>' : "") +
            (p.quote ? '<p class="quote">' + esc(p.quote) + '</p>' : "") +
            '</div>';
        }
        list.appendChild(li);
      });
      // 封面：统一在渲染后取 blob（不能直接写 src，见 loadImageInto）
      hydrateCovers();
      $("hero-pass").textContent = passCount;
    }).catch(function () { $("notes-empty").hidden = false; });
  }

  function hydrateCovers() {
    var imgs = document.querySelectorAll("#notes-list img[data-cover]");
    for (var i = 0; i < imgs.length; i += 1) {
      if (imgs[i].dataset.loaded === "1") continue;
      loadImageInto(imgs[i], "/frame?kind=cover&bvid=" + imgs[i].getAttribute("data-cover"));
    }
  }

  // ── 作息 ────────────────────────────────────────────────
  function loadRhythm() {
    api("/rhythm").then(function (r) {
      if (!r) return;
      var plan = r.plan || {};
      $("r-wakes").textContent = r.wakes ?? 0;
      $("hero-wake").innerHTML = (r.wakes ?? 0) + "<em>/" + (r.maxWakesPerDay ?? 3) + "</em>";

      var planText = plan.action === "wake" ? plan.atText
        : plan.action === "wait" ? plan.atText
        : "—";
      $("r-next").textContent = planText || "—";
      $("r-skip").textContent = Math.round((r.skipChance ?? 0) * 100) + "%";
      $("r-wins").textContent = (r.windows || []).length;

      var wl = $("rhythm-windows");
      if (wl) {
        wl.innerHTML = (r.windows || []).map(function (w) {
          return '<li class="plain"><div class="content"><h3>' + esc(w.label) + '</h3></div></li>';
        }).join("");
      }

      var tl = $("rhythm-tl");
      if (tl) {
        tl.innerHTML = (r.recent || []).map(function (h, i) {
          var label = h.action === "wake" ? "醒" : h.action === "wait" ? "等"
            : h.action === "skip" ? "不看" : "结束";
          return '<div class="ev' + (i === 0 ? " now" : "") + '">' +
            '<div class="t"><b>' + esc(label) + '</b>' +
            (h.window ? " · " + esc(h.window) : "") +
            (h.atText ? " @ " + esc(h.atText) : "") + '</div>' +
            '<div class="m">' + esc(ts(h.at)) + (h.reason ? " · " + esc(h.reason) : "") + '</div></div>';
        }).join("");
      }
    }).catch(function () {});
  }

  // ── 草稿 ────────────────────────────────────────────────
  function loadDrafts() {
    api("/drafts").then(function (r) {
      var items = (r && r.items) || [];
      var list = $("drafts-list");
      list.innerHTML = "";
      $("drafts-empty").hidden = items.length > 0;
      items.slice().reverse().forEach(function (d) {
        var li = document.createElement("li");
        li.className = "plain";
        li.innerHTML = '<div class="content"><h3>' + esc(String(d.text || "").slice(0, 60)) + '</h3>' +
          '<div class="meta">' + esc(d.kind) + " · " + esc(d.status) + " · " + esc(ts(d.at)) + "</div></div>";
        list.appendChild(li);
      });
    }).catch(function () { $("drafts-empty").hidden = false; });
  }

  // ── 待拍板 ──────────────────────────────────────────────
  function loadReview() {
    api("/review?status=pending").then(function (r) {
      var items = (r && r.items) || [];
      var list = $("review-list");
      list.innerHTML = "";
      $("review-empty").hidden = items.length > 0;
      items.forEach(function (it) {
        var li = document.createElement("li");
        li.className = "plain";
        li.innerHTML = '<div class="content"><h3>' + esc(it.text) + '</h3>' +
          '<div class="meta">' + esc(ts(it.at)) + " · " + esc((it.reasons || []).join("；")) + '</div>' +
          '<div class="row"><button class="btn primary" data-approve="' + esc(it.id) + '">批准</button>' +
          '<button class="btn" data-reject="' + esc(it.id) + '">驳回</button></div></div>';
        list.appendChild(li);
      });
      list.querySelectorAll("[data-approve]").forEach(function (b) {
        b.addEventListener("click", function () { resolveReview(b.getAttribute("data-approve"), "resolved"); });
      });
      list.querySelectorAll("[data-reject]").forEach(function (b) {
        b.addEventListener("click", function () { resolveReview(b.getAttribute("data-reject"), "rejected"); });
      });
    }).catch(function () { $("review-empty").hidden = false; });
  }

  function resolveReview(id, status) {
    hana.api.fetch("/review/" + encodeURIComponent(id), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: status })
    }).then(function () { loadReview(); loadAudit(); }).catch(function () {});
  }

  // ── 账本 ────────────────────────────────────────────────
  function renderQuota(q) {
    var grid = $("quota-grid");
    if (!grid || !q) return;
    var caps = q.caps || {};
    var keys = ["comment", "dynamic", "dm", "share"];
    var LABEL = { comment: "评论", dynamic: "动态", dm: "私信", share: "分享" };
    grid.innerHTML = keys.map(function (k) {
      var c = caps[k] || { used: 0, cap: 0 };
      var pct = c.cap > 0 ? Math.round((c.used / c.cap) * 100) : 0;
      return '<div class="cell"><div class="lbl">' + esc(LABEL[k]) + '</div>' +
        '<div class="val">' + esc(c.used) + '<small> / ' + esc(c.cap) + '</small></div>' +
        '<div class="sub">余 ' + esc(c.left ?? 0) + '</div>' +
        '<div class="bar"><i style="width:' + pct + '%"></i></div></div>';
    }).join("");
  }

  // 账本：说人话。DRY_RUN 是「预演」，SENT 是「已发出」。
  // 预演占绝大多数且全是没发生的事 → 默认折叠，只留真动作。
  var DECISION_TEXT = {
    DRY_RUN: "预演（没真发）",
    SENT: "已发出",
    BLOCK: "被拦下",
    SKIP: "跳过",
  };
  var ACTION_TEXT = {
    comment: "评论",
    dynamic: "动态",
    dm: "私信",
    follow: "关注",
    share: "分享",
    publish: "发布",
  };

  function loadAudit() {
    api("/audit").then(function (r) {
      var items = (r && r.items) || [];
      var list = $("audit-list");
      var dry = items.filter(function (a) {
        return String(a.decision || "").toUpperCase() === "DRY_RUN";
      });
      var real = items.filter(function (a) {
        return String(a.decision || "").toUpperCase() !== "DRY_RUN";
      });
      // 真动作在前，预演折叠在末尾
      var shown = real.concat(dry.slice(0, 3));

      list.innerHTML = "";
      $("audit-empty").hidden = items.length > 0;

      shown.forEach(function (a) {
        var raw = String(a.decision || "").toUpperCase();
        var dec = DECISION_TEXT[raw] || raw || "?";
        var act = ACTION_TEXT[a.action] || a.action || "";
        var reason = a.reason || (a.reasons || []).join("；") || a.hint || "";
        var li = document.createElement("li");
        li.className = raw === "DRY_RUN" ? "plain dim" : "plain";
        li.innerHTML = '<div class="content"><h3>' + esc(dec) +
          (act ? " · " + esc(act) : "") +
          (a.kind && ACTION_TEXT[a.kind] ? " · " + esc(ACTION_TEXT[a.kind]) : "") +
          '</h3>' +
          '<div class="meta">' + esc(ts(a.at)) + (reason ? " · " + esc(reason) : "") + "</div></div>";
        list.appendChild(li);
      });

      if (dry.length > 3) {
        var more = document.createElement("li");
        more.className = "plain dim";
        more.innerHTML = '<div class="content"><div class="meta">另有 ' +
          (dry.length - 3) + ' 条预演记录（没真发，已省略）</div></div>';
        list.appendChild(more);
      }
    }).catch(function () { $("audit-empty").hidden = false; });
  }

  // ── 日记 ────────────────────────────────────────────────
  var diaryWhich = "private";

  /**
   * 极简行内 markdown：**粗** / *斜* / `代码`
   *
   * 为什么需要：她写日记时会自然带 markdown（她按对话习惯写），
   * 但之前只做了 esc()，星号原样显示成 `**流的构成**`。
   * 不引入完整解析器——只处理这三种，而且**先 esc 再替换**，不会引入 XSS。
   */
  function inlineMd(s) {
    var t = esc(s);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    t = t.replace(/`([^`]+)`/g, '<code style="font-size:.94em;background:rgba(140,90,43,.08);padding:1px 4px;border-radius:2px">$1</code>');
    t = t.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<i>$2</i>");
    return t;
  }

  function renderDiary(items) {
    var list = $("diary-list");
    if (!list) return;
    list.innerHTML = "";
    $("diary-empty").hidden = items.length > 0;
    items.forEach(function (d) {
      var li = document.createElement("li");
      li.className = "plain";
      var body = String(d.text || "").split("\n").map(function (line) {
        return inlineMd(line);
      }).join("<br>");
      li.innerHTML = '<div class="content"><div class="meta">' + esc(ts(d.at)) +
        (d.title ? ' · <b style="font-weight:600;color:var(--ink-2)">' + esc(d.title) + '</b>' : '') +
        '</div><p class="note" style="margin-top:6px">' + body + "</p></div>";
      list.appendChild(li);
    });
  }

  function loadDiary() {
    $("diary-head").textContent = diaryWhich === "private"
      ? "不加滤镜的那本（给她自己）"
      : "写给你的那本";
    api("/diary?which=" + diaryWhich).then(function (r) {
      renderDiary((r && r.items) || []);
    }).catch(function () { renderDiary([]); });
  }

  var dsw = $("diary-switch");
  if (dsw) {
    dsw.querySelectorAll("button[data-which]").forEach(function (b) {
      b.addEventListener("click", function () {
        diaryWhich = b.getAttribute("data-which");
        dsw.querySelectorAll("button[data-which]").forEach(function (x) {
          x.classList.toggle("on", x === b);
        });
        loadDiary();
      });
    });
  }

  // ── 设置（P17：App 内，不再弹浏览器）────────────────────
  // [键, 控件, 标签, 提示, 危险?]
  var SET_FIELDS = [
    ["autoPostEnabled", "checkbox", "允许自主发布（kill switch）", "关闭 = 只读。刷内容、写笔记照常，但不发任何东西", true],
    ["socialEnabled", "checkbox", "点对点开关（关注 / 私信）", "开启后她能关注别人、发私信。不影响公开发言", false],
    ["publishLive", "checkbox", "真发（关闭 = 预演）", "关闭时只组装请求不发送", true],
    ["allowProactiveComment", "checkbox", "允许主动评论", "她会自己去别人视频下说话，比回话外显得多。默认关", true],
    ["scope", "text", "发言白名单", "逗号分隔，例 BV1xx,uid:123。空 = 谁都不发", false],

    ["nightWindows", "text", "作息窗口", "窗口固定、时刻随机。格式 HH:MM-HH:MM，逗号分隔", false],
    ["maxWakesPerDay", "number", "每天最多醒几次", "硬上限。手动叫醒也计入", false],
    ["skipChance", "number", "今晚不看的概率", "0.3 = 三成。每次醒来独立掷", false],
    ["maxVideos", "number", "初筛条数", "醒来后先拉几条候选", false],
    ["deepRead", "number", "深读条数", "从候选里挑几条真读（1-3）", false],

    ["like", "text", "爱看", "逗号分隔。命中加权", false],
    ["dislike", "text", "不爱看", "逗号分隔。命中直接剔除", false],
    ["minScore", "number", "分享门槛（满分 20）", "5 项各 0-4 分，≥ 此值才「值得说」", false],

    ["quotaComment", "number", "普通评论 / 天", "", false],
    ["quotaDynamic", "number", "动态 / 天", "", false],
    ["quotaDm", "number", "私信 / 天", "", false],
    ["quotaLike", "number", "点赞 / 天", "最轻的对外动作，但也不能无限", false],
    ["shareDaily", "number", "分享 / 天", "", false],
    ["sameTargetDays", "number", "同一目标冷却（天）", "只对分享型生效", false],

    ["silentAfterDays", "number", "沉默几天后开始降额", "", false],
    ["silentStopDays", "number", "沉默几天后停发", "", false],

    ["personaName", "text", "角色名", "", false],
    ["ownerTitle", "text", "她怎么称呼你", "", false],
    ["ownerMid", "text", "你的 B站 mid", "私信收件人。填上后她会把看完的东西私信给你（需互关）", false],
    ["notifyOnWake", "checkbox", "醒来后发通知", "", false],
    ["wakeMode", "select", "醒来方式", "brain = 她自己用模型想（花 token）；rule = 纯规则", false],
    ["brainFallback", "checkbox", "brain 失败时退回规则", "", false],
    ["shareToOwner", "checkbox", "看完递一条给你", "挑一条带 BV 链接的用私信递给你", false],
    ["shareMaxPerDay", "number", "每天最多递几条", "", false],
  ];

  // ── 身份：选助手 / 头像 / 人格 ─────────────────────────
  //
  // 搬设置时漏掉的一块。没有它，「这个 App 由谁在过」就没法改，
  // 而 brain.js 的 pickModel 是「优先用选中 agent 的模型」——
  // 选中谁，决定了她说话用哪个模型。

  var identityLoaded = false;
  var currentAgentId = "";   // 当前选中的助手，人格读写都按它

  function renderIdentity() {
    var host = $("set-identity");
    if (!host) return;
    if (identityLoaded) {
      // 已经建过 DOM —— 但内容可能被改动过（比如自动刷新），
      // 所以只在「用户没在编辑」时才回填，否则会把刚打的字冲掉。
      maybeRefreshPersona();
      return;
    }
    identityLoaded = true;

    // 与设置页其余部分用同一套类：.sg 分组 / .sr 行 / .sl 标签 / .sh 提示
    host.innerHTML =
      '<div class="sg">身份</div>' +

      '<div class="sr" style="display:block">' +
        '<div class="sl">由哪位助手来过这个账号</div>' +
        '<div class="sh">选中谁，她就用谁的人格和模型。换人不换封面</div>' +
        '<div id="agent-pick" class="agent-grid"><div class="agent-empty">读取中…</div></div>' +
      '</div>' +

      '<div class="sr">' +
        '<div>' +
          '<div class="sl">头像</div>' +
          '<div class="sh">卡片和面板里的那张脸。写入 dataDir，不进日志</div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<div id="avatar-preview" class="avatar-preview"><span>无</span></div>' +
          '<label class="filebtn">选择<input type="file" id="avatar-file" accept="image/png,image/webp,image/svg+xml,image/jpeg" /></label>' +
        '</div>' +
      '</div>' +

      '<div class="sr" style="display:block">' +
        '<div class="sl">人格提示词</div>' +
        '<div class="sh">她是谁、怎么说话。<b>默认读助手自己的 identity.md + AGENTS.md</b>；' +
          '你改过之后保存的会覆盖它（按助手分别保存）</div>' +
        '<textarea id="persona-box" placeholder="还没读到人格"></textarea>' +
        '<div class="sactions">' +
          '<button class="btn primary" id="save-persona">保存人格</button>' +
          '<button class="btn" id="reset-persona" title="删掉你的覆盖，恢复助手原始文件">恢复原始设定</button>' +
          '<span class="sstatus" id="persona-status"></span>' +
        '</div>' +
      '</div>';

    loadAgents();
    loadPersona();
    loadAvatar();
    bindIdentity();
  }

  function loadAgents() {
    var box = $("agent-pick");
    if (!box) return;
    api("/agents").then(function (r) {
      var list = (r && (r.agents || r.items)) || [];
      if (!list.length) {
        box.innerHTML = '<div class="agent-empty">' +
          ((r && r.reason) || "没读到助手列表") + '</div>';
        return;
      }
      Promise.resolve(api("/identity")).then(function (id) {
        var cur = (id && (id.agentId || (id.selection && id.selection.agentId))) || "";
        currentAgentId = cur;
        var hint = cur ? "" : '<div class="agent-hint">尚未指定 · 未指定时用宿主当前模型</div>';
        box.innerHTML = hint + list.map(function (a) {
          var ch = (a.id === cur) ? " on" : "";
          // 宿主不返回头像 → 用首字，字号按字大小撑
          var av = esc((a.name || a.id || "?").slice(0, 1));
          return '<button class="agent-card' + ch + '" data-agent="' + esc(a.id) + '">' +
            '<span class="av">' + av + '</span>' +
            '<span class="nm">' + esc(a.name || a.id) + '</span>' +
            '</button>';
        }).join("");

        box.querySelectorAll(".agent-card").forEach(function (el) {
          el.addEventListener("click", function () {
            var id2 = el.getAttribute("data-agent");
            var st = $("persona-status");
            if (st) st.textContent = "切换中…";
            api("/identity", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ agentId: id2 }),
            }).then(function (res) {
              box.querySelectorAll(".agent-card").forEach(function (x) {
                x.classList.toggle("on", x === el);
              });
              currentAgentId = id2;
              // 每个助手有自己的文件 —— 切换后必须重读
              loadPersona();
              if (st) st.textContent = "已切换到 " + id2 + "，正在读它的人格…";
            }).catch(function (e) {
              if (st) st.textContent = "切换失败：" + (e && e.message || e);
            });
          });
        });
      });
    }).catch(function (e) {
      box.innerHTML = '<div class="agent-empty">读不到：' + esc(e && e.message || e) + '</div>';
    });
  }

  // 编辑中的内容不能被自动刷新冲掉。
  // 判据：textarea 有 focus，或值跟上次读到的不一样（用户改过）。
  var personaDirty = false;
  var personaLastLoaded = "";

  function maybeRefreshPersona() {
    var ta = $("persona-box");
    if (!ta) return;
    if (document.activeElement === ta) return;   // 正在编辑
    if (personaDirty) return;                     // 改过还没保存
    loadPersona();
  }

  function loadPersona() {
    var ta = $("persona-box");
    if (!ta) return;
    // 正在编辑 / 有未保存改动 → 不覆盖
    if (document.activeElement === ta || personaDirty) return;
    api("/persona" + (currentAgentId ? "?agentId=" + encodeURIComponent(currentAgentId) : "")).then(function (r) {
      var v = (r && r.persona) || "";
      personaLastLoaded = v;
      ta.value = v;
      personaDirty = false;
      var st = $("persona-status");
      if (st) {
        var src = (r && r.source) || "";
        var label = src === "override" ? "你的覆盖版"
          : src === "agent-files" ? "助手原始文件"
          : src === "default" ? "默认"
          : "本地文件";
        var extra = "";
        if (src === "agent-files" && r.files) {
          var fs2 = r.files;
          extra = "（identity " + (fs2["identity.md"]?.length || 0) +
                  " + AGENTS " + (fs2["AGENTS.md"]?.length || 0) + " 字）";
        }
        st.textContent = v.length + " 字 · 来源：" + label + extra;
      }
    }).catch(function () { /* 忽略 */ });
  }

  function updatePersonaMeta() {
    var ta = $("persona-box");
    var st = $("persona-status");
    if (ta && st && !st.textContent) st.textContent = ta.value.length + " 字";
  }

  function loadAvatar() {
    api("/identity").then(function (r) {
      var prev = $("avatar-preview");
      if (!prev) return;
      if (r && r.hasAvatar) {
        prev.innerHTML = '<img alt="">';
        loadImageInto(prev.querySelector("img"), "/avatar");
      } else {
        prev.innerHTML = '<span>无</span>';
      }
    }).catch(function () { /* 忽略 */ });
  }

  function bindIdentity() {
    // 输入就标脏，防自动刷新冲掉
    var ta0 = $("persona-box");
    if (ta0) {
      ta0.addEventListener("input", function () {
        personaDirty = ta0.value !== personaLastLoaded;
        var st = $("persona-status");
        if (st) st.textContent = ta0.value.length + " 字" + (personaDirty ? " · 未保存" : "");
      });
    }

    var save = $("save-persona");
    if (save) {
      save.addEventListener("click", function () {
        var ta = $("persona-box");
        var st = $("persona-status");
        if (!ta) return;
        if (st) st.textContent = "保存中…";
        api("/persona", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ persona: ta.value, agentId: currentAgentId || undefined }),
        }).then(function (r) {
          if (r && r.ok) {
            // 回读确认：服务端说 ok，再拉一次比内容
            return api("/persona").then(function (back) {
              var saved = (back && back.persona) || "";
              personaDirty = saved !== ta.value;
              personaLastLoaded = saved;
              if (st) {
                st.textContent = personaDirty
                  ? ("保存后读回不一致（" + saved.length + " / " + ta.value.length + " 字）")
                  : ("已保存 · " + saved.length + " 字 · 已回读确认");
              }
            });
          }
          if (st) st.textContent = "失败：" + ((r && r.error) || "未知");
        }).catch(function (e) {
          if (st) st.textContent = "失败：" + (e && e.message || e);
        });
      });
    }

    var reset = $("reset-persona");
    if (reset) {
      reset.addEventListener("click", function () {
        var st = $("persona-status");
        if (st) st.textContent = "恢复中…";
        api("/persona/reset", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId: currentAgentId || undefined }),
        }).then(function (r) {
          if (r && r.ok) {
            loadPersona();
            if (st) st.textContent = r.removed ? "已恢复助手原始设定" : "本来就没有覆盖版";
          } else if (st) {
            st.textContent = "失败：" + ((r && r.error) || "未知");
          }
        }).catch(function (e) {
          if (st) st.textContent = "失败：" + (e && e.message || e);
        });
      });
    }

    var file = $("avatar-file");

    // 互动页的两个按钮
    var dbtn = $("digest-run");
    if (dbtn) {
      dbtn.addEventListener("click", function () {
        var sel = $("digest-hours");
        loadDigest(Number(sel && sel.value) || 24);
      });
    }
    var fbtn = $("allow-forget");
    if (fbtn) {
      fbtn.addEventListener("click", function () {
        var st = $("allow-status");
        if (st) st.textContent = "清中…";
        api("/allowlist/forget", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
          .then(function (r) {
            if (st) st.textContent = (r && r.ok) ? "已清空" : "失败";
            loadAllowlist();
          })
          .catch(function (e) { if (st) st.textContent = "失败：" + (e && e.message || e); });
      });
    }
    if (file) {
      file.addEventListener("change", function () {
        var f0 = file.files && file.files[0];
        if (!f0) return;
        var reader = new FileReader();
        reader.onload = function () {
          api("/avatar", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ data: reader.result, ext: f0.name.split(".").pop() }),
          }).then(function () { loadAvatar(); }).catch(function () { /* 忽略 */ });
        };
        reader.readAsDataURL(f0);
      });
    }
  }

  var settingsBuilt = false;

  function buildSettings() {
    renderIdentity();
    if (settingsBuilt) return;
    var host = $("settings-host");
    if (!host) return;

    var groups = [
      { title: "安全开关", keys: ["autoPostEnabled", "socialEnabled", "publishLive", "allowProactiveComment", "scope"] },
      { title: "作息", keys: ["nightWindows", "maxWakesPerDay", "skipChance", "maxVideos", "deepRead"] },
      { title: "口味", keys: ["like", "dislike", "minScore"] },
      { title: "配额", keys: ["quotaComment", "quotaDynamic", "quotaDm", "quotaLike", "shareDaily", "sameTargetDays"] },
      { title: "沉默衰减", keys: ["silentAfterDays", "silentStopDays"] },
      { title: "人设与通知", keys: ["personaName", "ownerTitle", "ownerMid", "notifyOnWake", "wakeMode", "brainFallback", "shareToOwner", "shareMaxPerDay"] },
    ];

    var byKey = {};
    SET_FIELDS.forEach(function (f) { byKey[f[0]] = f; });

    var html = "";
    groups.forEach(function (g) {
      html += '<div class="sg">' + esc(g.title) + "</div>";
      g.keys.forEach(function (k) {
        var f = byKey[k];
        if (!f) return;
        var ctrl;
        if (f[1] === "checkbox") {
          ctrl = '<input type="checkbox" id="set-' + k + '" />';
        } else if (f[1] === "select") {
          ctrl = '<select id="set-' + k + '"></select>';
        } else {
          var wide = (k === "like" || k === "dislike" || k === "scope" || k === "nightWindows") ? ' class="wide"' : "";
          ctrl = '<input type="' + f[1] + '" id="set-' + k + '"' + wide + ' />';
        }
        html += '<div class="sr' + (f[4] ? " danger" : "") + '">' +
          '<div><div class="sl">' + esc(f[2]) + "</div>" +
          (f[3] ? '<div class="sh">' + esc(f[3]) + "</div>" : "") +
          "</div>" + ctrl + "</div>";
      });
    });

    html += '<div class="sactions">' +
      '<button class="btn primary" id="set-save">保存</button>' +
      '<button class="btn" id="set-reload">重新读取</button>' +
      '<span class="sstatus" id="set-status"></span></div>' +
      '<div class="swarn" id="set-warn"></div><div class="serr" id="set-err"></div>';

    host.innerHTML = html;
    settingsBuilt = true;

    $("set-save").addEventListener("click", saveSettings);
    $("set-reload").addEventListener("click", loadSettings);
  }

  function fillSettings(cfg) {
    SET_FIELDS.forEach(function (f) {
      var k = f[0], type = f[1];
      var el = $("set-" + k);
      if (!el) return;
      var v = cfg[k];
      if (type === "checkbox") {
        el.checked = v === true;
      } else if (type === "select") {
        var opts = k === "wakeMode" ? ["brain", "rule"] : [];
        el.innerHTML = opts.map(function (o) {
          return '<option value="' + o + '">' + (o === "brain" ? "她自己想（brain）" : "纯规则（rule）") + "</option>";
        }).join("");
        el.value = v || opts[0];
      } else {
        el.value = Array.isArray(v) ? v.join(",") : (v === undefined || v === null ? "" : String(v));
      }
    });
  }

  function collectSettings() {
    var patch = {};
    SET_FIELDS.forEach(function (f) {
      var k = f[0], type = f[1];
      var el = $("set-" + k);
      if (!el) return;
      if (type === "checkbox") patch[k] = el.checked;
      else if (type === "number") patch[k] = Number(el.value);
      else patch[k] = el.value;
    });
    return patch;
  }

  function loadSettings() {
    buildSettings();
    $("set-status").textContent = "读取中…";
    $("set-err").textContent = "";
    $("set-warn").textContent = "";
    api("/config").then(function (r) {
      fillSettings((r && r.config) || {});
      $("set-status").textContent = "已读取";
    }).catch(function (e) {
      $("set-status").textContent = "";
      $("set-err").textContent = "读取失败：" + (e && e.message ? e.message : e);
    });
  }

  function saveSettings() {
    $("set-status").textContent = "保存中…";
    $("set-err").textContent = "";
    $("set-warn").textContent = "";
    var patch = collectSettings();
    api("/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then(function (r) {
      if (r && r.ok) {
        $("set-status").textContent = "已保存";
        if (r.warnings && r.warnings.length) $("set-warn").textContent = r.warnings.join("；");
        loadSettings();
        loadHealth();
      } else {
        $("set-status").textContent = "";
        $("set-err").textContent = "保存失败：" + ((r && r.error) || "未知");
      }
    }).catch(function (e) {
      $("set-status").textContent = "";
      $("set-err").textContent = "保存失败：" + (e && e.message ? e.message : e);
    });
  }

  // ── 接入 ────────────────────────────────────────────────
  function loadSetup() {
    api("/config").then(function (r) {
      var c = (r && r.config) || {};
      $("cfg-persona").textContent = c.personaName || "—";
      $("cfg-owner").textContent = c.ownerTitle || "—";
      $("cfg-via").textContent = c.shareVia || "—";
      $("cfg-min").textContent = (c.minScore ?? "—") + " / 20";
      $("cfg-scope").textContent = (c.scope && c.scope.length) ? c.scope.join(", ") : "空（谁都不发）";

    }).catch(function () {});
    api("/health").then(function (h) {
      $("cred-state").textContent = h && h.credentialsConfigured ? "已配置" : "未配置";
    }).catch(function () {});
  }

  var saveCredBtn = $("save-cred");
  if (saveCredBtn) {
    saveCredBtn.addEventListener("click", function () {
      $("cred-err").textContent = "";
      var body = {
        sessdata: $("ck-sessdata").value,
        bili_jct: $("ck-jct").value,
        buvid3: $("ck-buvid3").value,
      };
      hana.api.fetch("/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then(readJson).then(function (r) {
        if (r && r.ok) {
          $("ck-sessdata").value = ""; $("ck-jct").value = ""; $("ck-buvid3").value = "";
          $("cred-state").textContent = "已配置";
          loadHealth();
        } else {
          $("cred-err").textContent = "缺少：" + ((r && r.missing) || []).join("、");
        }
      }).catch(function () { $("cred-err").textContent = "写入失败"; });
    });
  }

  // 侧栏开关项：点一下跳设置页


  var refreshBtn = $("refresh");
  if (refreshBtn) refreshBtn.addEventListener("click", function () { loadAll(); });

  // 自动刷新：Studio 也是常驻卡，不自己更新。
  // 60 秒一次（Studio 拉的数据多，比窄栏稀一些）。
  setInterval(function () {
    if (document.hidden) return;
    loadAll();
  }, 60 * 1000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) loadAll();
  });

  // 设置入口：切到 Studio 内的设置页签（不再弹浏览器）
  var setBtn = $("open-settings");
  if (setBtn) {
    setBtn.addEventListener("click", function () { switchTab("settings"); });
  }

  function loadAll() {
    loadHealth(); loadNotes(); loadRhythm(); loadDrafts(); loadReview(); loadAudit(); loadSetup(); loadDiary(); loadSettings();
    loadDigest(24); loadAllowlist(); loadTaste(); loadSent(); bindRetract();
  }

  var started = false;
  function startOnce() { if (started) return; started = true; loadAll(); }
  try {
    hana.ready();
    if (hana.surface && typeof hana.surface.onContextChanged === "function") {
      hana.surface.onContextChanged(function (ctx) { if (ctx) startOnce(); });
    }
    setTimeout(startOnce, 500);
  } catch (e) { startOnce(); }
})();
