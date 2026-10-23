// 设置页脚本（module）——走 hana.api.fetch，读写 /config
import { hana } from "./sdk.js";

(function () {
  "use strict";

  /** [字段名, 控件类型] */
  var FIELDS = [
    ["autoPostEnabled", "checkbox"],
    ["socialEnabled", "checkbox"],
    ["publishLive", "checkbox"],
    ["allowProactiveComment", "checkbox"],
    ["scope", "text"],
    ["nightWindows", "text"],
    ["maxWakesPerDay", "number"],
    ["maxManualWakesPerDay", "number"],
    ["skipChance", "number"],
    ["maxVideos", "number"],
    ["deepRead", "number"],
    ["like", "text"],
    ["dislike", "text"],
    ["minScore", "number"],
    ["quotaComment", "number"],
    ["quotaDynamic", "number"],
    ["quotaDm", "number"],
    ["shareDaily", "number"],
    ["sameTargetDays", "number"],
    ["silentAfterDays", "number"],
    ["silentStopDays", "number"],
    ["personaName", "text"],
    ["ownerTitle", "text"],
    ["ownerMid", "text"],
    ["notifyOnWake", "checkbox"],
    ["shareToOwner", "checkbox"],
    ["shareMaxPerDay", "number"],
    ["wakeMode", "select"],
    ["brainFallback", "checkbox"],
    ["wakeEnabled", "checkbox"],
    ["listenComment", "checkbox"],
    ["listenDm", "checkbox"],
    ["shareVia", "select"],
  ];

  function $(id) { return document.getElementById(id); }
  function setStatus(t) { var e = $("status"); if (e) e.textContent = t || ""; }
  function setErr(t) { var e = $("err"); if (e) e.textContent = t || ""; }
  function setWarn(t) { var e = $("warn"); if (e) e.textContent = t || ""; }

  function readJson(res) {
    if (res && typeof res.text === "function") {
      return res.text().then(function (t) {
        try { return JSON.parse(t); } catch (e) { throw new Error("HTTP " + res.status + "：" + (t.slice(0, 120) || "空响应")); }
      });
    }
    return Promise.resolve(res);
  }

  function api(path, opts) {
    return Promise.resolve(hana.api.fetch(path, opts || {})).then(readJson);
  }

  function fill(cfg) {
    FIELDS.forEach(function (pair) {
      var key = pair[0], kind = pair[1];
      var el = $(key);
      if (!el) return;
      var v = cfg[key];
      if (kind === "checkbox") el.checked = v === true;
      else if (kind === "select") el.value = v || "";
      else el.value = (v === undefined || v === null) ? "" : v;
    });
  }

  function collect() {
    var out = {};
    FIELDS.forEach(function (pair) {
      var key = pair[0], kind = pair[1];
      var el = $(key);
      if (!el) return;
      if (kind === "checkbox") out[key] = el.checked;
      else if (kind === "number") out[key] = el.value === "" ? undefined : Number(el.value);
      else out[key] = el.value;
    });
    return out;
  }

  function checkWarnings(cfg) {
    var ws = [];
    if (!String(cfg.scope || "").trim()) ws.push("白名单为空 → 谁都不会发（这是安全默认，要发需填 BV/uid/room）");
    if (!String(cfg.like || "").trim()) ws.push("「爱看」为空 → 偏好分一直是 0，挑片只看热度");
    if (cfg.publishLive === true && cfg.autoPostEnabled !== true) ws.push("开了「真发」但 kill switch 还关着，实际不会发");
    setWarn(ws.join("；"));
  }

  function load() {
    setErr(""); setStatus("读取中…");
    api("/config").then(function (r) {
      var cfg = (r && r.config) || {};
      fill(cfg);
      checkWarnings(cfg);
      setStatus("已读取");
    }).catch(function (e) {
      setErr("读取失败：" + (e && e.message ? e.message : e));
      setStatus("");
    });
  }

  function save() {
    setErr(""); setStatus("保存中…");
    var body = collect();
    api("/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (r && r.ok === false) { setErr("保存被拒：" + (r.error || "")); setStatus(""); return; }
      setStatus("已保存");
      checkWarnings(body);
      setTimeout(load, 400);
    }).catch(function (e) {
      setErr("保存失败：" + (e && e.message ? e.message : e));
      setStatus("");
    });
  }

  // ── 身份：选助手 / 头像 / 人格 ───────────────────────────────
  var currentAgentId = "";

  function loadIdentity() {
    api("/identity").then(function (r) {
      var sel = (r && r.selection) || {};
      currentAgentId = sel.agentId || "";
      paintAvatar(r && r.hasAvatar);
    }).catch(function () {});
    api("/agents").then(function (r) {
      paintAgents((r && r.agents) || [], r && r.ok === false ? (r.reason || "读取失败") : "");
    }).catch(function (e) { paintAgents([], e.message); });
    api("/persona").then(function (r) {
      var el = $("persona");
      if (el) el.value = (r && r.persona) || "";
    }).catch(function () {});
  }

  function paintAvatar(has) {
    var box = $("avatar-preview");
    if (!box) return;
    box.innerHTML = has ? '<img src="/api/apps/peikan/routes/avatar?t=' + Date.now() + '" alt="头像">' : '<span>无</span>';
  }

  function paintAgents(list, reason) {
    var box = $("agent-pick");
    if (!box) return;
    if (!list.length) {
      box.innerHTML = '<div class="agent-empty">' + (reason || "没有可用的助手") + '</div>';
      return;
    }
    box.innerHTML = list.map(function (a) {
      var on = a.id === currentAgentId ? " on" : "";
      return '<div class="agent-card' + on + '" data-id="' + esc(a.id) + '" data-name="' + esc(a.name) + '">' +
        '<div class="av">' + esc((a.name || "?").slice(0, 1)) + '</div>' +
        '<div><div class="nm">' + esc(a.name) + '</div>' +
        '<div class="id2">' + esc(a.yuan || a.identity || "") + '</div></div></div>';
    }).join("");
    box.querySelectorAll(".agent-card").forEach(function (el) {
      el.addEventListener("click", function () {
        var id = el.getAttribute("data-id");
        var name = el.getAttribute("data-name");
        currentAgentId = id;
        box.querySelectorAll(".agent-card").forEach(function (x) { x.classList.remove("on"); });
        el.classList.add("on");
        api("/identity", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId: id, agentName: name })
        }).catch(function () {});
      });
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var fileEl = $("avatar-file");
  if (fileEl) {
    fileEl.addEventListener("change", function () {
      var f = fileEl.files && fileEl.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        var b64 = String(reader.result || "");
        var ext = (f.name.split(".").pop() || "png").toLowerCase();
        api("/avatar", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: b64, ext: ext })
        }).then(function () { paintAvatar(true); }).catch(function () {});
      };
      reader.readAsDataURL(f);
    });
  }

  var savePersonaBtn = $("save-persona");
  if (savePersonaBtn) {
    savePersonaBtn.addEventListener("click", function () {
      var st = $("persona-status");
      if (st) st.textContent = "保存中…";
      api("/persona", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona: $("persona").value })
      }).then(function () {
        if (st) st.textContent = "已保存";
      }).catch(function (e) {
        if (st) st.textContent = "失败：" + (e && e.message ? e.message : e);
      });
    });
  }

  $("save").addEventListener("click", save);
  $("reload").addEventListener("click", load);

  try { hana.ready(); } catch (e) { /* 无宿主 */ }
  setTimeout(function () { load(); loadIdentity(); }, 500);
})();
