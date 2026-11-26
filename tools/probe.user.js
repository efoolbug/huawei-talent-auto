// ==UserScript==
// @name         HuaweiTalentAuto · 诊断探针 (Probe)
// @namespace    https://local.htap/
// @version      0.1.0
// @description  只读诊断：记录加载时间线、脚本报错、长任务、首个 <video> 出现时间。用于对比 1.0.0 启用/禁用时的差异。
// @match        https://e.huawei.com/cn/talent/*
// @run-at       document-start
// @grant        GM_info
// @noframes
// @compatible   chrome
// ==/UserScript==

/* 说明：
 * 1) 本脚本只读，不修改页面 DOM、不改样式。
 * 2) 使用 @grant GM_info 强制 Tampermonkey 沙箱，避免与页面全局作用域冲突
 *    （这正是 1.0.0 很可能踩中的坑，见 docs/01-故障分析与诊断.md）。
 * 3) 12 秒后 / 30 次采样后，在控制台输出摘要，并写入 window.__HTAP_PROBE_SUMMARY__。
 */
(function () {
  'use strict';

  const P = {
    start: Math.round(performance.now()),
    markers: [],
    errors: [],
    longTasks: [],
    samples: [],
    firstVideo: null,
    firstAppChildren: null,
    hashChanges: []
  };
  window.__HTAP_PROBE__ = P;

  const now = () => Math.round(performance.now());
  const mark = (name, extra) => P.markers.push({ t: now(), name, extra: extra || null });
  const clip = (s, n) => { s = s === null || s === undefined ? '' : String(s); return s.length > n ? s.slice(0, n) + '…' : s; };

  mark('document-start', { readyState: document.readyState, href: location.href });

  /* ---- 1. 未捕获异常（含脚本解析错误） ---- */
  window.addEventListener('error', (e) => {
    P.errors.push({
      t: now(),
      type: 'error',
      msg: clip(e.message || (e.target && (e.target.src || e.target.href)) || '', 300),
      file: e.filename ? clip(e.filename, 120) : null,
      line: e.lineno || null,
      stack: e.error && e.error.stack ? clip(e.error.stack, 600) : null
    });
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    P.errors.push({ t: now(), type: 'rejection', msg: clip((r && r.message) || r, 300) });
  });

  /* ---- 2. 长任务 ---- */
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        P.longTasks.push({ t: Math.round(e.startTime), d: Math.round(e.duration) });
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (_) { /* 浏览器不支持则跳过 */ }

  /* ---- 3. 关键时间点 ---- */
  const waitBody = () => {
    if (document.body) {
      mark('body-ready', { children: document.body.children.length });
      return;
    }
    if (now() - P.start > 20000) return;
    setTimeout(waitBody, 20);
  };
  waitBody();

  window.addEventListener('DOMContentLoaded', () => mark('DOMContentLoaded'));
  window.addEventListener('load', () => mark('load'));
  window.addEventListener('hashchange', () => {
    P.hashChanges.push({ t: now(), hash: location.hash });
    mark('hashchange', { hash: location.hash });
  });

  /* ---- 4. 每秒采样 ---- */
  let ticks = 0;
  let done = false;

  const timer = setInterval(() => {
    ticks++;

    let videoCount = 0;
    try { videoCount = document.querySelectorAll('video').length; } catch (_) {}
    P.samples.push({ t: now(), videos: videoCount });

    if (P.firstAppChildren === null) {
      const app = document.querySelector('#app') || document.body;
      if (app && app.children.length > 0) {
        P.firstAppChildren = now();
        mark('app-rendered', { children: app.children.length });
      }
    }

    if (P.firstVideo === null) {
      const v = document.querySelector('video');
      if (v) {
        P.firstVideo = now();
        mark('first-video', { src: clip(v.currentSrc || v.src, 100), paused: v.paused });
      }
    }

    if (ticks >= 30) summarize('30s 到期');
  }, 1000);

  /* ---- 5. 摘要 ---- */
  function summarize(reason) {
    if (done) return;
    done = true;
    clearInterval(timer);

    const summary = {
      reason,
      url: location.href,
      markers: P.markers,
      errors: P.errors,
      longTaskCount: P.longTasks.length,
      longTaskMax: P.longTasks.reduce((m, x) => Math.max(m, x.d), 0),
      longTaskTotal: P.longTasks.reduce((a, x) => a + x.d, 0),
      firstAppRenderedMs: P.firstAppChildren,
      firstVideoMs: P.firstVideo,
      hashChanges: P.hashChanges,
      videoSamples: P.samples.filter((_, i) => i % 5 === 0)
    };

    window.__HTAP_PROBE_SUMMARY__ = summary;
    console.log('%c[HTAP Probe] 加载摘要', 'font-weight:bold;font-size:13px;color:#0a7', summary);

    if (P.errors.length) {
      console.warn('[HTAP Probe] 捕获到 ' + P.errors.length + ' 条脚本错误：');
      console.table(P.errors.map((e) => ({ t: e.t, type: e.type, msg: e.msg, file: e.file, line: e.line })));
    }
    if (P.firstVideo === null) {
      console.warn('[HTAP Probe] 12s/30s 内主文档没有出现 <video>：播放器在 iframe / Shadow DOM / Canvas，或尚未加载。');
    }
  }

  setTimeout(() => summarize('12s 到期'), 12000);
})();
