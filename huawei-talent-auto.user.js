// ==UserScript==
// @name         Huawei Talent Auto Player
// @namespace    HuaweiTalent
// @author       HuaweiTalentAuto contributors
// @license      MIT
// @version      2.2.0
// @description  华为人才在线课程播放辅助：自动倍速/音量/播放/下一讲。修复 1.0.0 的页面空白（MutationObserver 自激循环）。
// @match        https://e.huawei.com/cn/talent/outPage/*
// @match        https://talent.shixizhi.huawei.com/course/*
// @run-at       document-idle
// @grant        GM_info
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @compatible   chrome
// ==/UserScript==

/* ============================================================================
 * 2.2.0：修复「一个章节里的多个 Part 只播 1~2 个就整段跳过」
 *        实测有些小节（如 8.1 BGP路径属性）在同一个页面里垂直堆叠了
 *        Part 01…Part 06 共 6 个 video.js 播放器，底部的「上一讲 / 下一讲」
 *        是**章节级**按钮。旧逻辑里任何一个 <video> 触发 ended 都会去点它，
 *        于是 Part 02 一播完就被带到 8.2，8.1 永远打不上勾。
 *        现在：
 *        1) 只跟踪「当前正在播的那一个」视频，其它堆叠播放器的 ended 一律忽略；
 *        2) 当前 Part 播完后，先把同一小节里排在它下面的 Part 逐个激活播放
 *           （识别页面上的 Part 0X 标题，3 个、4 个、6 个都自适应；
 *            站点自己会接续时则让站点接，脚本不抢）；
 *        3) 本小节全部 Part 播完，才点「下一讲」；
 *        4) 「下一讲」只在离当前播放器最近的候选里点，避免点到其它 Part 的按钮；
 *        5) 诊断结果会带上子框架的视频 / Part 结构，定位问题不用再开 DevTools。
 * ============================================================================
 * 2.1.0：新增「无视频小节自动跳过」——图文/课件页没有 <video>，永远等不到
 *        ended。现在在该页停留 10s 后自动点「下一讲」；面板可开关；
 *        识别到测验/答题页面时拒绝跳过。
 * ============================================================================
 * 2.0.3：修复两个致命判断
 *        1) 「下一讲」只认"自身文本整段就是下一讲"的元素，不再点到
 *           同时包住「上一讲 / 下一讲」的外层容器（div.switch-btn）。
 *        2) ended 只接受主播放器、时长 ≥ 30s、且不是刚开播 5 秒内的假结束。
 * ============================================================================
 * 2.0.2：子框架日志回传到主面板（面板里能看到 iframe 内发生了什么）；
 *        站点自己把视频暂停时自动续播；用户刚点过鼠标则视为手动暂停，不抢。
 * ============================================================================
 * 2.0.1：播放器实际运行在 talent.shixizhi.huawei.com 的跨域 iframe 内，
 *        增加该域的 @match；由拥有播放器的那个 frame 自己负责倍速/音量/下一讲，
 *        子框架把状态与"播放结束"通过 postMessage 上报给主框架。
 * ============================================================================
 * 2.0.0 相对 1.0.0 的修复要点
 * ----------------------------------------------------------------------------
 * 1. [致命] 观察器回调里绝不写 DOM。1.0.0 的 monitor() 会改面板文本，而面板
 *    就在被观察的 body 子树里 → 微任务级无限循环 → 主线程冻结、页面空白。
 *    现在：回调只置一个 debounce 定时器，扫描函数只读不写。
 * 2. 面板放在 Shadow DOM 里，面板内部的所有文字更新对文档观察器不可见。
 * 3. 面板文本更新一律做值比较，值没变就不写。
 * 4. 不改任何原生原型，只在 <video> 实例上设 playbackRate / volume / muted。
 * 5. 下一讲用「一次性锁 + 导航变化确认 + 30s 冷却」，杜绝无限切课。
 * 6. 支持子框架：视频在 iframe 里也能控制，结束信号用 postMessage 转给主框架。
 * 7. 所有自动化可暂停（自动下一讲开关）/ 可完全停止（停止按钮）。
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 0. 单实例守卫
   * ------------------------------------------------------------------ */
  const pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  try {
    if (pageWindow.__HTAP_ACTIVE__) return;
    pageWindow.__HTAP_ACTIVE__ = true;
  } catch (e) { return; }

  const VERSION = '2.2.0';
  const IS_TOP = (function () {
    try { return window.top === window; } catch (e) { return false; }
  })();

  /* ------------------------------------------------------------------ *
   * 1. 配置：持久化到 TM 存储
   * ------------------------------------------------------------------ */
  const clamp = function (n, a, b) { return Math.min(b, Math.max(a, n)); };

  function loadCfg() {
    const d = {
      rate: 2, volume: 0, autoNext: true, autoPlay: true,
      nextDelayMs: 1500,
      skipNoVideo: false,        // 无视频（图文/课件）小节：停留一段时间后自动下一讲
      skipNoVideoDelayMs: 10000  // 停留多久再跳过
    };
    try {
      const raw = GM_getValue('htap.cfg', '');
      if (!raw) return d;
      const o = JSON.parse(raw) || {};
      return {
        rate: clamp(Number(o.rate) || d.rate, 0.25, 8),
        volume: clamp(Number.isFinite(Number(o.volume)) ? Number(o.volume) : d.volume, 0, 1),
        autoNext: o.autoNext !== false,
        autoPlay: o.autoPlay !== false,
        nextDelayMs: clamp(Number(o.nextDelayMs) || d.nextDelayMs, 0, 30000),
        skipNoVideo: o.skipNoVideo === true,
        skipNoVideoDelayMs: clamp(Number(o.skipNoVideoDelayMs) || d.skipNoVideoDelayMs, 5000, 60000)
      };
    } catch (e) {
      return d;
    }
  }

  const cfg = loadCfg();
  let saveCfgTimer = null;
  function saveCfg() {
    clearTimeout(saveCfgTimer);
    saveCfgTimer = setTimeout(function () {
      try { GM_setValue('htap.cfg', JSON.stringify(cfg)); } catch (e) { /* 忽略 */ }
    }, 200);
  }

  /* ------------------------------------------------------------------ *
   * 2. 运行状态
   * ------------------------------------------------------------------ */
  const state = {
    running: false,
    stoppedByUser: false,
    startedAt: Date.now(),
    primary: null,          // 当前主视频元素
    lastLoggedVideo: null,  // 只对这个元素打一次「识别到播放器」，防止刷屏
    videoCount: 0,
    nextState: 'idle',      // idle | waiting | clicked
    nextAttempts: 0,
    nextBlockedUntil: 0,
    lastCourseScan: 0,
    lastReport: 0,
    lastUserInputAt: 0,     // 用于区分"用户手动暂停"和"站点自己暂停"
    noVideoSince: 0,        // 当前页面「没有播放器」的起始时间（用于图文小节跳过）
    skippedHref: '',        // 已经跳过过的页面，防止重复触发
    course: { title: '', active: '' },
    active: null,           // 当前正在跟的播放器（多 Part 堆叠时只跟"正在播的那一个"）
    // 主框架用：子框架上报的播放状态（视频在跨域 iframe 里时）
    child: null,
    // 主框架用：子框架回报的结构（诊断用）
    childDiag: null
  };

  /* ------------------------------------------------------------------ *
   * 3. 日志（环形缓冲，只写面板/控制台，不写被观察的 DOM 子树）
   * ------------------------------------------------------------------ */
  const LOG_MAX = 200;
  const logBuf = [];

  function log(level, msg, isRemote) {
    const item = {
      t: new Date().toTimeString().slice(0, 8),
      level: level || 'info',
      msg: String(msg)
    };
    logBuf.push(item);
    if (logBuf.length > LOG_MAX) logBuf.shift();

    const tag = '[HTAP v' + VERSION + ']';
    if (level === 'error') console.error(tag, msg);
    else if (level === 'warn') console.warn(tag, msg);
    else console.log(tag, msg);

    renderLog();

    // 子框架的日志转发到主框架面板：否则 iframe 里的失败在面板上完全看不见
    if (!isRemote && !IS_TOP) {
      try {
        window.top.postMessage({ __htap: 'log', level: item.level, msg: item.msg, t: item.t }, '*');
      } catch (e) { /* 忽略 */ }
    }
  }

  /* ------------------------------------------------------------------ *
   * 4. 播放器发现与绑定
   * ------------------------------------------------------------------ */
  const bound = new WeakSet();
  const boundList = [];      // WeakSet 不可遍历，另存一份用于停止时还原
  let writing = false;       // 正在写属性，忽略自己触发的 ratechange
  let lastShadowScan = 0;

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (r.width <= 0 || r.height <= 0) return false;
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { return true; }
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  function collectVideos() {
    const out = [];
    const add = function (v) { if (v && out.indexOf(v) === -1) out.push(v); };

    try { document.querySelectorAll('video').forEach(add); } catch (e) { /* 忽略 */ }

    // Shadow DOM 中的播放器：限频 + 限预算，避免在大页面上制造长任务
    const now = Date.now();
    if (now - lastShadowScan > 2000 || out.length === 0) {
      lastShadowScan = now;
      try {
        const all = document.getElementsByTagName('*');
        const budget = Math.min(all.length, 2500);
        for (let i = 0; i < budget; i++) {
          const el = all[i];
          const sr = el && el.shadowRoot;
          if (sr) {
            try { sr.querySelectorAll('video').forEach(add); } catch (e) { /* 忽略 */ }
          }
        }
      } catch (e) { /* 忽略 */ }
    }
    return out;
  }

  /* ---- 多 Part 小节：同一页面里可能垂直堆叠着多个播放器 ---- */
  function absTop(el) {
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { return 0; }
    return r.top + (window.pageYOffset || document.documentElement.scrollTop || 0);
  }

  // 只把"看得见、有尺寸、有媒体源或时长"的视频当作小节内的 Part
  function partVideos(vids) {
    const out = [];
    for (let i = 0; i < vids.length; i++) {
      const v = vids[i];
      if (!isVisible(v)) continue;
      let w = 0;
      try { w = v.getBoundingClientRect().width; } catch (e) { w = 0; }
      if (w < 160) continue;
      if (!v.currentSrc && !v.getAttribute('src') && !(isFinite(v.duration) && v.duration > 0)) continue;
      out.push(v);
    }
    return out;
  }

  function orderedVideos(vids) {
    return vids.slice().sort(function (a, b) { return absTop(a) - absTop(b); });
  }

  let partCache = { at: 0, list: [] };

  // 页面上的「Part 01 / Part 02 …」标题：用来判断当前小节里有几个部分
  function getPartHeadings() {
    const now = Date.now();
    if (now - partCache.at < 2000) return partCache.list;
    partCache.at = now;

    const out = [];
    try {
      const all = document.querySelectorAll('body *');
      const budget = Math.min(all.length, 4000);
      for (let i = 0; i < budget; i++) {
        const el = all[i];
        if (el.children && el.children.length > 0) continue;
        const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 12) continue;
        if (!/^part\s*\d+$/i.test(t)) continue;
        out.push({ el: el, top: absTop(el), n: parseInt(t.replace(/\D/g, ''), 10) || 0 });
      }
    } catch (e) { /* 忽略 */ }

    out.sort(function (a, b) { return a.top - b.top; });
    // 同一个标题可能同时命中父子节点，按位置去重
    const uniq = [];
    for (let i = 0; i < out.length; i++) {
      if (!uniq.length || Math.abs(out[i].top - uniq[uniq.length - 1].top) > 4) uniq.push(out[i]);
    }
    partCache.list = uniq;
    return uniq;
  }

  function resetPartCache() { partCache.at = 0; partCache.list = []; }

  function partIndexOf(v, headings) {
    let center;
    try { center = absTop(v) + (v.getBoundingClientRect().height || 0) / 2; } catch (e) { center = absTop(v); }
    let idx = -1;
    for (let i = 0; i < headings.length; i++) {
      if (headings[i].top <= center) idx = i;
      else break;
    }
    return idx;
  }

  // 当前视频所在小节里的"下一个部分"；返回 null 表示本小节已经全部播完
  function findNextPart(v, vids) {
    const headings = getPartHeadings();
    const ordered = orderedVideos(partVideos(vids || collectVideos()));

    if (headings.length >= 2) {
      const idx = partIndexOf(v, headings);
      if (idx >= 0) {
        if (idx >= headings.length - 1) return null;   // 已经是最后一个 Part
        const h = headings[idx + 1];
        const limit = headings[idx + 2] ? headings[idx + 2].top : Infinity;
        let target = null;
        for (let i = 0; i < ordered.length; i++) {
          const t = absTop(ordered[i]);
          if (t >= h.top - 2 && t < limit) { target = ordered[i]; break; }
        }
        return { heading: h, video: target, reason: 'Part ' + (h.n || (idx + 2)) };
      }
    }

    // 没有分 Part 标题（或对不上）：按垂直顺序取当前视频下面的第一个
    const i = ordered.indexOf(v);
    if (i >= 0 && i < ordered.length - 1) {
      return { heading: null, video: ordered[i + 1], reason: '下一部分' };
    }
    return null;
  }

  function adoptActive(v) {
    state.active = v;
    state.primary = v;
  }

  // 选"当前正在看的那一个"视频，避免在多个堆叠播放器之间乱跳
  function resolveActive(vids) {
    const cur = state.active;
    let curOk = false;
    try { curOk = !!(cur && cur.isConnected); } catch (e) { curOk = false; }

    if (curOk && !cur.paused && !cur.ended && cur.currentTime > 0) return cur;

    // 站点自己把下一部分接上了：跟着它走（刚开始播时 currentTime 可能还是 0，不能要求 > 0）
    for (let i = 0; i < vids.length; i++) {
      const v = vids[i];
      if (v === cur) continue;
      if (!v.paused && !v.ended && isVisible(v)) return v;
    }

    // 当前视频还在（用户手动暂停）：保持不动
    if (curOk) return cur;

    // 新页面：优先选有进度但没播完的，其次从上到下第一个
    const ordered = orderedVideos(partVideos(vids));
    for (let i = 0; i < ordered.length; i++) {
      if (!ordered[i].ended && ordered[i].currentTime > 0) return ordered[i];
    }
    return ordered.length ? ordered[0] : null;
  }

  let partTimer = null;

  function scheduleNextPart(target, fromVideo) {
    clearTimeout(partTimer);
    const delay = clamp(cfg.nextDelayMs, 1200, 5000);
    log('info', '本小节还有下一部分（' + target.reason + '），先把剩余部分播完');
    partTimer = setTimeout(function () {
      partTimer = null;
      goToNextPart(target, fromVideo, 0);
    }, delay);
  }

  // 激活小节的下一部分：站点自己会接就让它接，不抢；接不上才自己播
  function goToNextPart(target, fromVideo, attempt) {
    if (!state.running || state.stoppedByUser) return;
    attempt = attempt || 0;

    const vids = collectVideos();

    // 站点已经自己开始播别的部分了：跟着走
    for (let i = 0; i < vids.length; i++) {
      const x = vids[i];
      if (x !== fromVideo && !x.paused && !x.ended && isVisible(x)) {
        log('info', '站点已自动播放下一部分，脚本不干预');
        adoptActive(x);
        return;
      }
    }

    let v = target.video;
    if (!v || !v.isConnected) {
      const fresh = findNextPart(fromVideo, vids);
      if (fresh && fresh.video) { target = fresh; v = fresh.video; }
      else v = null;
    }

    if (!v) {
      if (attempt >= 3) {
        // 宁可停在这里，也不越过剩余的 Part 跳到下一章
        log('warn', '下一部分视频没能加载出来，停在当前部分（不会跳章）');
        return;
      }
      if (target.heading && target.heading.el) {
        try { target.heading.el.scrollIntoView({ block: 'center' }); } catch (e) { /* 忽略 */ }
        log('info', '滚动到下一部分，等待播放器加载…');
      }
      setTimeout(function () { goToNextPart(target, fromVideo, attempt + 1); }, 1200);
      return;
    }

    try { v.scrollIntoView({ block: 'center' }); } catch (e) { /* 忽略 */ }
    adoptActive(v);
    applyTo(v);
    v.__htapEndedHandled = false;
    v.__htapAutoTried = true;

    let p = null;
    try { p = v.play(); } catch (e) { log('warn', '播放下一部分异常：' + e.message); return; }
    if (p && typeof p.then === 'function') {
      p.then(function () {
        log('info', '已开始播放下一部分（' + target.reason + '）');
      }).catch(function (err) {
        if (err && err.name === 'NotAllowedError') {
          log('warn', '浏览器阻止自动播放下一部分，请点一次视频');
          armGesturePlay();
        } else if (!err || err.name !== 'AbortError') {
          log('warn', '播放下一部分失败：' + (err && err.message ? err.message : '未知'));
        }
      });
    } else {
      log('info', '已尝试播放下一部分（' + target.reason + '）');
    }
  }

  function applyTo(v) {
    if (!v || !state.running) return;
    writing = true;
    try {
      if (Math.abs(v.playbackRate - cfg.rate) > 0.001) v.playbackRate = cfg.rate;

      const vol = clamp(cfg.volume, 0, 1);
      if (Math.abs(v.volume - vol) > 0.001) v.volume = vol;

      const shouldMute = vol === 0;
      if (v.muted !== shouldMute) v.muted = shouldMute;
    } catch (e) {
      log('warn', '设置播放参数失败：' + e.message);
    } finally {
      writing = false;
    }
  }

  function tryAutoplay(v) {
    if (!cfg.autoPlay || !state.running || !v) return;
    if (v.__htapAutoTried) return;
    if (!v.currentSrc && !v.getAttribute('src')) return;   // 还没有源
    if (!v.paused) return;

    v.__htapAutoTried = true;
    let p;
    try { p = v.play(); } catch (e) { log('warn', '调用 play() 异常：' + e.message); return; }
    if (!p || typeof p.catch !== 'function') return;

    p.then(function () {
      log('info', '已自动开始播放');
    }).catch(function (err) {
      const name = err && err.name;
      if (name === 'NotAllowedError') {
        log('warn', '浏览器阻止自动播放，请点击一次页面');
        armGesturePlay();
      } else if (name !== 'AbortError') {
        log('warn', '自动播放失败：' + (err && err.message ? err.message : name));
      }
    });
  }

  // 强制续播（用于站点自己把视频暂停、或切换到新讲后停在封面）
  function forcePlay(v) {
    if (!v || !state.running) return;
    if (v.__htapBlocked) return;   // 已确认被自动播放策略拦截，等用户手势，别反复刷日志
    let p = null;
    try { p = v.play(); } catch (e) { return; }
    if (p && typeof p.catch === 'function') {
      p.then(function () {
        log('info', '续播成功');
      }).catch(function (err) {
        if (err && err.name === 'NotAllowedError') {
          v.__htapBlocked = true;
          log('warn', '浏览器阻止播放：请在视频画面上点一次');
          armGesturePlay();
        }
      });
    }
  }

  let gestureArmed = false;
  function armGesturePlay() {
    if (gestureArmed) return;
    gestureArmed = true;
    const handler = function () {
      document.removeEventListener('pointerdown', handler, true);
      document.removeEventListener('keydown', handler, true);
      gestureArmed = false;
      const v = state.primary;
      if (v && state.running) { try { v.play(); } catch (e) { /* 忽略 */ } }
    };
    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('keydown', handler, true);
  }

  function onVideoEnded(v) {
    if (!state.running || state.stoppedByUser) return;
    if (v.__htapEndedHandled) return;

    // 多播放器堆叠时只认「当前正在看的那个」，其它播放器的 ended 一律忽略
    if (v !== state.active) {
      log('info', '非当前视频结束，忽略');
      return;
    }
    if (!isVisible(v)) {
      log('info', '视频元素不可见，忽略结束事件');
      return;
    }
    if (!(v.duration >= 30)) {
      log('info', '忽略短视频结束事件（时长 ' + Math.round(v.duration || 0) + 's）');
      return;
    }
    if (v.__htapPlayStartedAt && Date.now() - v.__htapPlayStartedAt < 5000) {
      log('info', '忽略刚开播 5 秒内触发的结束事件');
      return;
    }

    v.__htapEndedHandled = true;
    log('info', '视频播放结束');

    if (!cfg.autoNext) {
      log('info', '自动下一讲已关闭，停在当前讲');
      return;
    }

    // 本小节还有没播完的 Part：先播完，绝不能直接跳下一章
    const next = findNextPart(v, collectVideos());
    if (next) {
      scheduleNextPart(next, v);
      return;
    }

    // 谁拥有播放器谁负责切课；子框架找不到按钮再请主框架帮忙
    if (IS_TOP || findNextButton()) {
      requestNext('ended');
    } else {
      log('info', '子框架内未找到下一讲按钮，请求主框架');
      sendToTop('needNext');
    }
  }

  function bindVideo(v) {
    if (!v || bound.has(v)) return false;
    bound.add(v);
    boundList.push({ v: v, orig: { rate: v.playbackRate, volume: v.volume, muted: v.muted } });

    const onApply = function () { if (state.running) applyTo(v); };

    v.addEventListener('loadedmetadata', onApply);
    v.addEventListener('canplay', function () { onApply(); tryAutoplay(v); });
    v.addEventListener('seeked', onApply);
    v.addEventListener('play', function () {
      v.__htapEndedHandled = false;
      v.__htapResumes = 0;
      v.__htapBlocked = false;
      v.__htapPlayStartedAt = Date.now();
      onApply();
    });
    v.addEventListener('ratechange', function () {
      if (writing) return;
      // 站点把倍速重置了：再套用一次（限频，避免抖动）
      const now = Date.now();
      if (Math.abs(v.playbackRate - cfg.rate) > 0.001 && now - (v.__htapLastFix || 0) > 300) {
        v.__htapLastFix = now;
        setTimeout(function () { applyTo(v); }, 0);
      }
    });
    v.addEventListener('emptied', function () { v.__htapAutoTried = false; });
    v.addEventListener('error', function () {
      const e = v.error;
      log('error', '视频报错：' + (e ? 'code=' + e.code + (e.message ? ' ' + e.message : '') : '未知'));
    });
    v.addEventListener('ended', function () { onVideoEnded(v); });

    onApply();
    return true;
  }

  function applyAll() {
    for (let i = 0; i < boundList.length; i++) {
      if (boundList[i].v) applyTo(boundList[i].v);
    }
  }

  function restoreVideos() {
    for (let i = 0; i < boundList.length; i++) {
      const item = boundList[i];
      const v = item && item.v;
      if (!v) continue;
      try {
        writing = true;
        v.playbackRate = item.orig.rate;
        v.volume = item.orig.volume;
        v.muted = item.orig.muted;
      } catch (e) { /* 忽略 */ } finally {
        writing = false;
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 5. 下一讲：识别原生按钮 + 单次锁 + 变化确认
   * ------------------------------------------------------------------ */
  const NEXT_TEXTS = ['下一讲', '下一节', '下一课', '下一个', '下一集'];

  function normText(el) {
    if (!el) return '';
    let s = el.innerText;
    if (s === undefined || s === null) s = el.textContent;
    return String(s || '').replace(/\s+/g, '');
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled === true) return true;
    try {
      if (el.getAttribute('aria-disabled') === 'true') return true;
      const cls = el.className;
      const s = (cls && cls.baseVal !== undefined) ? cls.baseVal : String(cls || '');
      if (/(^|[\s_-])(disabled|is-disabled|u-disabled|btn-disabled)([\s_-]|$)/i.test(s)) return true;
    } catch (e) { /* 忽略 */ }
    return false;
  }

  // 只认"元素自身文本整段就是下一讲"的节点。
  // 关键：绝不能返回同时包住「上一讲」「下一讲」的外层容器（曾经点中 div.switch-btn 导致无反应）
  function stripDecor(s) {
    return String(s || '').replace(/[\s>»›→‹«<]/g, '');
  }

  function isNextLabel(el) {
    const t = stripDecor(el.textContent);
    if (!t || t.length > 8) return false;
    for (let i = 0; i < NEXT_TEXTS.length; i++) {
      if (t === NEXT_TEXTS[i]) return true;
    }
    return false;
  }

  function findNextButton(useAncestor) {
    // 第一梯队：可点击语义元素（候选少，优先）
    const groups = [
      'button, a, [role="button"], [onclick], [class*="btn"], [class*="button"], [class*="next"], [class*="Next"]',
      // 第二梯队：纯文本叶子节点，点击会冒泡到父级处理器
      'span, i, em, b, li'
    ];

    const cands = [];
    const addCand = function (el) {
      for (let i = 0; i < cands.length; i++) {
        if (cands[i] === el || cands[i].contains(el) || el.contains(cands[i])) return;
      }
      cands.push(el);
    };

    for (let g = 0; g < groups.length; g++) {
      let list = [];
      try { list = Array.prototype.slice.call(document.querySelectorAll(groups[g])); } catch (e) { list = []; }

      for (let i = 0; i < list.length; i++) {
        const el = list[i];
        if (g === 1 && el.children && el.children.length > 0) continue;
        if (!isNextLabel(el)) continue;
        if (!isVisible(el) || isDisabled(el)) continue;
        addCand(el);
      }
    }

    if (!cands.length) return null;

    // 多 Part 页面里可能有多个「下一讲」：选离当前播放器最近的那个
    let found = cands[0];
    const ref = state.active || state.primary;
    if (ref && ref.getBoundingClientRect) {
      let rr = null;
      try { rr = ref.getBoundingClientRect(); } catch (e) { rr = null; }
      if (rr) {
        const rc = rr.top + rr.height / 2;
        let best = Infinity;
        for (let i = 0; i < cands.length; i++) {
          let r;
          try { r = cands[i].getBoundingClientRect(); } catch (e) { continue; }
          // 位于播放器上方的（上一讲方向）排到最后
          const above = r.top < rr.top ? 100000 : 0;
          const d = Math.abs((r.top + r.height / 2) - rc) + above;
          if (d < best) { best = d; found = cands[i]; }
        }
      }
    }

    // 重试时换一种点法：点最近的可交互祖先（仍要求它的文本就是"下一讲"，不能是外层容器）
    if (found && useAncestor) {
      try {
        const anc = found.closest('button, a, [role="button"], [onclick], [tabindex]');
        if (anc && anc !== found && isNextLabel(anc)) return anc;
      } catch (e) { /* 忽略 */ }
    }

    return found;
  }

  function snapshotNav() {
    const frames = [];
    try {
      document.querySelectorAll('iframe').forEach(function (f) {
        frames.push(f.getAttribute('src') || '');
      });
    } catch (e) { /* 忽略 */ }
    const v = state.primary;
    return {
      href: location.href,
      title: document.title,
      video: v,
      src: v ? (v.currentSrc || v.getAttribute('src') || '') : '',
      wasEnded: v ? !!v.ended : false,
      frames: frames.join('|')
    };
  }

  function navChangedSince(before) {
    if (location.href !== before.href) return true;
    if (document.title !== before.title) return true;

    const nowV = state.primary;
    if (nowV !== before.video) return true;
    if (nowV) {
      const src = nowV.currentSrc || nowV.getAttribute('src') || '';
      if (src && src !== before.src) return true;
      // iframe 内的 SPA 常常复用同一个 video 元素：以"结束后又重新开始播放"作为切换成功的信号
      if (before.wasEnded && !nowV.ended && nowV.currentTime < 5) return true;
    }

    const frames = [];
    try {
      document.querySelectorAll('iframe').forEach(function (f) {
        frames.push(f.getAttribute('src') || '');
      });
    } catch (e) { /* 忽略 */ }
    if (frames.join('|') !== before.frames) return true;

    return false;
  }

  let nextTimer = null;

  function requestNext(reason) {
    if (!state.running || state.stoppedByUser) return;

    if (!cfg.autoNext) {
      log('info', '自动下一讲已关闭，忽略（' + reason + '）');
      return;
    }
    if (state.nextState !== 'idle') {
      log('info', '切换流程进行中，忽略重复触发');
      return;
    }
    if (Date.now() < state.nextBlockedUntil) {
      log('warn', '切换冷却中，' + Math.ceil((state.nextBlockedUntil - Date.now()) / 1000) + 's 后再试');
      return;
    }

    state.nextState = 'waiting';
    state.nextAttempts = 0;
    log('info', '准备切换下一讲（' + reason + '），' + Math.round(cfg.nextDelayMs / 100) / 10 + 's 后执行');

    clearTimeout(nextTimer);
    nextTimer = setTimeout(function () { doNext(reason); }, cfg.nextDelayMs);
  }

  function doNext(reason, useAncestor) {
    if (!state.running || state.nextState !== 'waiting') return;

    const before = snapshotNav();
    const btn = findNextButton(useAncestor);

    if (!btn) {
      if (!IS_TOP) {
        state.nextState = 'idle';
        log('warn', '子框架内未找到下一讲按钮，交给主框架');
        sendToTop('needNext');
        return;
      }
      failNext('未找到「下一讲」按钮（可能已到最后一讲）');
      return;
    }
    if (isDisabled(btn)) { failNext('「下一讲」按钮当前不可点击'); return; }

    state.nextState = 'clicked';
    try {
      btn.click();
    } catch (e) {
      failNext('点击异常：' + e.message);
      return;
    }
    const btnDesc = btn.tagName.toLowerCase() +
      (btn.id ? '#' + btn.id : '') +
      (typeof btn.className === 'string' && btn.className
        ? '.' + btn.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '');
    log('info', '已点击下一讲「' + normText(btn).slice(0, 8) + '」<' + btnDesc + '>');
    watchNavChange(before);
  }

  function watchNavChange(before) {
    const deadline = Date.now() + 15000;
    const iv = setInterval(function () {
      if (!state.running) { clearInterval(iv); return; }

      if (navChangedSince(before)) {
        clearInterval(iv);
        state.nextState = 'idle';
        state.nextAttempts = 0;
        log('info', '已切换到下一讲');
        updatePanel();
        return;
      }

      if (Date.now() > deadline) {
        clearInterval(iv);
        if (state.nextAttempts < 1) {
          state.nextAttempts += 1;
          log('warn', '未检测到切换，重试一次');
          state.nextState = 'waiting';
          doNext('重试', true);
        } else {
          failNext('点击后 15s 内未检测到课程切换');
        }
      }
    }, 500);
  }

  function failNext(msg) {
    state.nextState = 'idle';
    state.nextBlockedUntil = Date.now() + 30000;
    log('error', '切换失败：' + msg + '；30s 内不再尝试');
    updatePanel();
  }

  /* ------------------------------------------------------------------ *
   * 6. 跨框架通信
   * ------------------------------------------------------------------ */
  function merge(obj, extra) {
    if (!extra) return obj;
    for (const k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) obj[k] = extra[k];
    }
    return obj;
  }

  function sendToTop(type, extra) {
    if (IS_TOP) return;
    try {
      window.top.postMessage(merge({ __htap: type, v: VERSION }, extra), '*');
    } catch (e) { /* 忽略 */ }
  }

  // 向下级 frame 广播；子框架收到父框架指令后会继续转发，支持多级 iframe
  function postToFrames(cmd, extra) {
    const msg = merge({ __htap: 'cmd', cmd: cmd, v: VERSION }, extra);
    try {
      document.querySelectorAll('iframe, frame').forEach(function (f) {
        try { f.contentWindow.postMessage(msg, '*'); } catch (e) { /* 忽略 */ }
      });
    } catch (e) { /* 忽略 */ }
  }

  function broadcast(cmd, extra) {
    postToFrames(cmd, extra);
  }

  function broadcastCfg() {
    if (!IS_TOP) return;
    broadcast('cfg', {
      cfg: {
        rate: cfg.rate,
        volume: cfg.volume,
        autoNext: cfg.autoNext,
        autoPlay: cfg.autoPlay,
        nextDelayMs: cfg.nextDelayMs,
        skipNoVideo: cfg.skipNoVideo,
        skipNoVideoDelayMs: cfg.skipNoVideoDelayMs
      }
    });
  }

  function isKnownFrame(src, doc, depth) {
    if (!src || src === window) return false;
    doc = doc || document;
    depth = depth || 0;
    if (depth > 3) return false;
    try {
      const fs = doc.querySelectorAll('iframe, frame');
      for (let i = 0; i < fs.length; i++) {
        const f = fs[i];
        if (f.contentWindow === src) return true;
        let sub = null;
        try { sub = f.contentDocument; } catch (e) { sub = null; }   // 跨域为 null
        if (sub && isKnownFrame(src, sub, depth + 1)) return true;
      }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  function onTopMessage(e) {
    const d = e && e.data;
    if (!d || typeof d !== 'object' || !d.__htap) return;
    if (!isKnownFrame(e.source)) return;   // 只接受本站已知子框架

    if (d.__htap === 'log') {
      const lv = (d.level === 'error' || d.level === 'warn') ? d.level : 'info';
      log(lv, '[子] ' + String(d.msg || '').slice(0, 200), true);
      return;
    }

    if (d.__htap === 'ended') {
      requestNext('子框架视频结束');
      return;
    }
    if (d.__htap === 'needNext') {
      requestNext('子框架请求切课');
      return;
    }
    if (d.__htap === 'diagdata' && d.data) {
      state.childDiag = d.data;
      return;
    }
    if (d.__htap === 'state' && d.data) {
      state.child = {
        at: Date.now(),
        video: !!d.data.video,
        paused: !!d.data.paused,
        t: Number(d.data.t) || 0,
        d: Number(d.data.d) || 0,
        rate: Number(d.data.rate) || 0,
        vol: Number(d.data.vol) || 0
      };
      updatePanel();
    }
  }

  function onChildMessage(e) {
    if (IS_TOP) return;
    if (e.source !== window.parent) return;   // 只接受父框架指令
    const d = e && e.data;
    if (!d || typeof d !== 'object' || d.__htap !== 'cmd') return;

    if (d.cmd !== 'cfg') log('info', '收到主框架指令：' + d.cmd);

    if (d.cmd === 'stop') {
      stopAutomation('主框架停止');
    } else if (d.cmd === 'start') {
      startAutomation();
    } else if (d.cmd === 'rescan') {
      state.primary = null;
      state.active = null;
      clearTimeout(partTimer); partTimer = null;
      resetPartCache();
      state.lastCourseScan = 0;
      scheduleScan(0);
    } else if (d.cmd === 'next') {
      if (state.running && state.nextState === 'idle') {
        if (state.active) {
          const nxt = findNextPart(state.active, collectVideos());
          if (nxt) {
            log('info', '手动：先播放本小节下一部分');
            goToNextPart(nxt, state.active, 0);
            return;
          }
          state.nextState = 'waiting';
          state.nextAttempts = 0;
          doNext('主框架手动');
        }
      }
    } else if (d.cmd === 'diag') {
      sendToTop('diagdata', { data: childStructure() });
    } else if (d.cmd === 'cfg' && d.cfg) {
      if (typeof d.cfg.rate === 'number') cfg.rate = clamp(d.cfg.rate, 0.25, 8);
      if (typeof d.cfg.volume === 'number') cfg.volume = clamp(d.cfg.volume, 0, 1);
      if (typeof d.cfg.autoNext === 'boolean') cfg.autoNext = d.cfg.autoNext;
      if (typeof d.cfg.autoPlay === 'boolean') cfg.autoPlay = d.cfg.autoPlay;
      if (typeof d.cfg.nextDelayMs === 'number') cfg.nextDelayMs = clamp(d.cfg.nextDelayMs, 0, 30000);
      if (typeof d.cfg.skipNoVideo === 'boolean') {
        cfg.skipNoVideo = d.cfg.skipNoVideo;
        if (d.cfg.skipNoVideo) state.noVideoSince = 0;   // 刚打开开关时重新计时
      }
      if (typeof d.cfg.skipNoVideoDelayMs === 'number') cfg.skipNoVideoDelayMs = clamp(d.cfg.skipNoVideoDelayMs, 5000, 60000);
      applyAll();
    }

    // 继续向下转发（多级 iframe）
    if (d.cmd === 'cfg') postToFrames('cfg', { cfg: d.cfg });
    else postToFrames(d.cmd, null);
  }

  /* ------------------------------------------------------------------ *
   * 7. 路由 / 定时扫描 / 观察器
   * ------------------------------------------------------------------ */
  let lastHref = location.href;
  let scanTimer = null;

  function onRouteChanged() {
    if (!state.running) return;
    lastHref = location.href;
    state.nextState = 'idle';
    state.nextBlockedUntil = 0;
    state.primary = null;
    state.active = null;
    clearTimeout(partTimer); partTimer = null;
    resetPartCache();
    state.lastCourseScan = 0;
    log('info', '路由变化，重新扫描播放器');
    scheduleScan(400);
  }

  function checkRoute() {
    if (location.href !== lastHref) onRouteChanged();
  }

  function scheduleScan(delay) {
    if (!state.running) return;
    if (scanTimer) return;                    // 已排队，合并
    scanTimer = setTimeout(function () {
      scanTimer = null;
      tick();
    }, delay || 150);
  }

  let tickTimer = null;
  let mo = null;

  function attachObserver() {
    if (mo) return;
    mo = new MutationObserver(function (records) {
      // 关键：这里绝不写 DOM。只置一个 debounce 标记。
      for (let i = 0; i < records.length; i++) {
        const t = records[i].target;
        if (panelHost && (t === panelHost || (t && panelHost.contains && panelHost.contains(t)))) continue;
        scheduleScan(150);
        return;
      }
    });
    try {
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      log('warn', '无法挂载 DOM 观察器：' + e.message);
    }
  }

  function detachObserver() {
    if (mo) { try { mo.disconnect(); } catch (e) { /* 忽略 */ } mo = null; }
  }

  function detectCourseInfo() {
    const clean = function (s) { return String(s || '').replace(/\s+/g, ' ').trim(); };
    let title = clean(document.title);
    title = title.replace(/^华为人才在线\s*[-—|]?\s*/, '').slice(0, 60);

    let active = '';
    try {
      const el = document.querySelector(
        '[class*="active"][class*="item"], [class*="current"][class*="item"], [class*="active"][class*="chapter"], .active, .current'
      );
      if (el) active = clean(el.innerText).slice(0, 40);
    } catch (e) { /* 忽略 */ }

    return { title: title, active: active };
  }

  // 粗略识别测验/答题页面：这类页面即使没有视频，也绝不能自动跳过
  function looksLikeQuiz() {
    try {
      const body = document.body;
      if (!body) return false;
      const t = String(body.innerText || '').slice(0, 6000);
      return /提交答案|开始考试|开始测验|交卷|答题卡|单选题|多选题|判断题|课程考试/.test(t);
    } catch (e) {
      return false;
    }
  }

  function tick() {
    if (!state.running || state.stoppedByUser) return;

    try {
      checkRoute();

      const vids = collectVideos();
      for (let i = 0; i < vids.length; i++) bindVideo(vids[i]);

      state.videoCount = vids.length;
      const active = resolveActive(vids);

      if (active !== state.active) {
        adoptActive(active);
        if (active) {
          if (active !== state.lastLoggedVideo) {
            state.lastLoggedVideo = active;
            log('info', '识别到播放器（' + (active.currentSrc ? '已有媒体源' : '暂无媒体源') + '）');
          }
          applyTo(active);
          tryAutoplay(active);
        }
      }

      // 站点自己把视频暂停（切讲后停在封面、播放器重置）时自动续播。
      // 用户刚点过鼠标则视为手动暂停，不抢控制权。
      const pv = state.primary;
      // 只处理"还停在开头"的情况（currentTime < 5），避免和用户中途暂停抢控制权
      if (pv && cfg.autoPlay && pv.paused && !pv.ended && pv.readyState >= 1 &&
          pv.currentTime < 5 &&
          Date.now() - state.lastUserInputAt > 2500 &&
          Date.now() - (pv.__htapLastResume || 0) > 5000 &&
          (pv.__htapResumes || 0) < 5) {
        pv.__htapLastResume = Date.now();
        pv.__htapResumes = (pv.__htapResumes || 0) + 1;
        log('info', '视频被暂停且无用户操作，自动续播（第 ' + pv.__htapResumes + ' 次）');
        forcePlay(pv);
      }

      // 无视频小节（图文/课件）：停留一段时间后自动点击「下一讲」
      // 注意：这里必须判断"整个文档一个视频都没有"，不能只看 primary，
      // 否则多 Part 页面切 part 的瞬间会被误判成图文页而跳章。
      if (!vids.length) {
        if (!state.noVideoSince) state.noVideoSince = Date.now();
        const waited = Date.now() - state.noVideoSince;
        // 顶层页面里如果有 iframe，说明播放器/内容在子框架，交给子框架处理，避免重复点击
        const canOwnSkip = !IS_TOP || document.querySelectorAll('iframe').length === 0;
        if (cfg.skipNoVideo && cfg.autoNext && canOwnSkip &&
            waited > cfg.skipNoVideoDelayMs &&
            state.nextState === 'idle' &&
            state.skippedHref !== location.href) {
          if (looksLikeQuiz()) {
            state.skippedHref = location.href;
            log('warn', '本节无视频，但页面疑似测验/答题，停止自动跳过');
          } else {
            state.skippedHref = location.href;
            log('info', '本节无视频（图文/课件），已停留 ' + Math.round(waited / 1000) + 's，自动下一讲');
            requestNext('无视频小节');
          }
        }
      } else {
        state.noVideoSince = 0;
      }

      if (Date.now() - state.lastCourseScan > 2000) {
        state.lastCourseScan = Date.now();
        state.course = detectCourseInfo();
      }

      // 子框架：把播放状态上报给主框架，面板才有内容可显示
      if (!IS_TOP && Date.now() - state.lastReport > 2000) {
        state.lastReport = Date.now();
        const pv = state.primary;
        sendToTop('state', {
          data: pv ? {
            video: true,
            paused: pv.paused,
            t: pv.currentTime,
            d: isFinite(pv.duration) ? pv.duration : 0,
            rate: pv.playbackRate,
            vol: pv.volume
          } : { video: false }
        });
      }

      updatePanel();
    } catch (e) {
      log('error', '扫描异常：' + e.message);
    }
  }

  /* ------------------------------------------------------------------ *
   * 8. 启动 / 停止
   * ------------------------------------------------------------------ */
  function startAutomation() {
    if (state.running) return;
    state.running = true;
    state.stoppedByUser = false;
    state.startedAt = Date.now();
    state.nextState = 'idle';
    resetPartCache();

    attachObserver();
    clearInterval(tickTimer);
    tickTimer = setInterval(tick, 500);

    tick();
    applyAll();
    log('info', '自动化已启动');
    updatePanel();
  }

  function stopAutomation(reason) {
    if (!state.running && state.stoppedByUser) return;
    state.running = false;
    state.stoppedByUser = true;

    detachObserver();
    clearInterval(tickTimer); tickTimer = null;
    clearTimeout(scanTimer); scanTimer = null;
    clearTimeout(nextTimer); nextTimer = null;
    clearTimeout(partTimer); partTimer = null;

    state.nextState = 'idle';
    restoreVideos();
    log('info', '自动化已停止' + (reason ? '（' + reason + '）' : ''));
    updatePanel();
  }

  /* ------------------------------------------------------------------ *
   * 9. 悬浮面板（Shadow DOM 隔离，内部更新不产生文档 mutation）
   * ------------------------------------------------------------------ */
  let panelHost = null;
  let els = {};

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const x = Math.floor(s % 60);
    return m + ':' + (x < 10 ? '0' : '') + x;
  }

  function createPanel() {
    if (!IS_TOP || panelHost) return;

    panelHost = document.createElement('div');
    panelHost.id = 'htap-host';
    panelHost.style.cssText =
      'position:fixed;right:16px;top:96px;z-index:2147483647;width:248px;' +
      'font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;';

    const root = panelHost.attachShadow({ mode: 'open' });

    root.innerHTML = [
      '<div class="box">',
      '  <div class="hd" id="hd">',
      '    <span class="dot" id="dot"></span>',
      '    <span class="tt">华为课程助手 v' + VERSION + '</span>',
      '    <button class="mini" id="collapse" title="折叠">−</button>',
      '  </div>',
      '  <div class="bd" id="bd">',
      '    <div class="row"><label>倍速</label><select id="rate">',
      '      <option value="0.5">0.5x</option><option value="0.75">0.75x</option>',
      '      <option value="1">1x</option><option value="1.25">1.25x</option>',
      '      <option value="1.5">1.5x</option><option value="1.75">1.75x</option>',
      '      <option value="2">2x</option><option value="2.5">2.5x</option>',
      '      <option value="3">3x</option>',
      '    </select></div>',
      '    <div class="row"><label>音量</label>',
      '      <input type="range" id="vol" min="0" max="100" step="1">',
      '      <span id="volLabel" style="color:#9aa0a6;width:34px;text-align:right">0%</span>',
      '    </div>',
      '    <div class="row"><label class="chk"><input type="checkbox" id="autoNext"> 自动下一讲</label></div>',
      '    <div class="row"><label class="chk"><input type="checkbox" id="autoPlay"> 自动播放</label></div>',
      '    <div class="row"><label class="chk"><input type="checkbox" id="skipNoVideo"> 无视频小节自动跳过</label></div>',
      '    <div class="status" id="status">正在初始化…</div>',
      '    <div class="course" id="course"></div>',
      '    <div class="hint" id="hint"></div>',
      '    <div class="btns">',
      '      <button id="nextBtn">下一讲</button>',
      '      <button id="rescan">重新扫描</button>',
      '      <button id="diag">诊断</button>',
      '      <button id="stop" class="danger">停止</button>',
      '    </div>',
      '    <div class="log" id="log"></div>',
      '  </div>',
      '</div>'
    ].join('');

    /* 样式：优先 constructable stylesheet（不受页面 CSP style-src 影响），失败回退 <style> */
    const CSS_TEXT = [
      '*{box-sizing:border-box}',
      '.box{font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#e8eaed;',
      '     background:#202124;border:1px solid #3c4043;border-radius:10px;overflow:hidden;',
      '     box-shadow:0 6px 24px rgba(0,0,0,.35);user-select:none}',
      '.hd{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#292a2d;cursor:move}',
      '.dot{width:8px;height:8px;border-radius:50%;background:#f9ab00;flex:none}',
      '.dot.on{background:#34a853}.dot.off{background:#ea4335}',
      '.tt{flex:1;font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.mini{background:transparent;border:0;color:#9aa0a6;cursor:pointer;padding:2px 6px;border-radius:4px;font-size:14px}',
      '.mini:hover{background:#3c4043;color:#fff}',
      '.bd{padding:8px 10px 10px}.bd.hide{display:none}',
      '.row{display:flex;align-items:center;gap:8px;margin:5px 0}',
      // 只约束"倍速/音量"这类纯文字标签；复选框的 label 不能被压窄，否则文字会竖排
      '.row>label:not(.chk){color:#9aa0a6;width:44px;flex:none}',
      '.chk{display:flex;align-items:center;gap:6px;color:#c9cdd2;cursor:pointer;flex:1;',
      '     white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.chk input[type=checkbox]{flex:none;margin:0}',
      'select,input[type=range]{flex:1;min-width:0}',
      'select{background:#303134;color:#e8eaed;border:1px solid #5f6368;border-radius:6px;padding:3px 6px;font:inherit}',
      'input[type=range]{accent-color:#8ab4f8}',
      '.status{margin-top:7px;color:#9aa0a6;word-break:break-all;min-height:18px}',
      '.course{margin-top:2px;color:#9aa0a6;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.hint{margin-top:4px;color:#fdd663;font-size:11px;line-height:1.4}',
      '.btns{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}',
      '.btns button{flex:1;min-width:62px;background:#303134;color:#e8eaed;border:1px solid #5f6368;',
      '             border-radius:6px;padding:5px 6px;cursor:pointer;font:inherit}',
      '.btns button:hover{background:#3c4043}',
      '.btns button.danger{background:#5f1e1e;border-color:#7a2a2a}',
      '.log{margin-top:6px;max-height:68px;overflow:auto;font:11px/1.45 ui-monospace,Consolas,monospace;',
      '     color:#9aa0a6;border-top:1px solid #3c4043;padding-top:6px}',
      '.log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.log .warn{color:#fdd663}.log .error{color:#f28b82}'
    ].join('');

    let styleOk = false;
    try {
      if (typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS_TEXT);
        root.adoptedStyleSheets = [sheet];
        styleOk = true;
      }
    } catch (e) {
      styleOk = false;
    }
    if (!styleOk) {
      const st = document.createElement('style');
      st.textContent = CSS_TEXT;
      root.appendChild(st);
    }

    document.body.appendChild(panelHost);

    const $ = function (id) { return root.getElementById(id) || root.querySelector('#' + id); };
    els = {
      hd: $('hd'), dot: $('dot'), bd: $('bd'), collapse: $('collapse'),
      rate: $('rate'), vol: $('vol'), volLabel: $('volLabel'),
      autoNext: $('autoNext'), autoPlay: $('autoPlay'), skipNoVideo: $('skipNoVideo'),
      status: $('status'), course: $('course'), hint: $('hint'),
      nextBtn: $('nextBtn'), rescan: $('rescan'), diag: $('diag'), stop: $('stop'),
      log: $('log')
    };

    /* ---- 把持久化配置同步到控件 ---- */
    let rateInList = false;
    for (let i = 0; i < els.rate.options.length; i++) {
      if (els.rate.options[i].value === String(cfg.rate)) { rateInList = true; break; }
    }
    if (!rateInList) {
      const opt = document.createElement('option');
      opt.value = String(cfg.rate);
      opt.textContent = cfg.rate + 'x';
      els.rate.appendChild(opt);
    }
    els.rate.value = String(cfg.rate);
    els.vol.value = String(Math.round(cfg.volume * 100));

    /* ---- 控件事件 ---- */
    els.rate.addEventListener('change', function () {
      const r = parseFloat(els.rate.value);
      if (!isFinite(r) || r <= 0) return;
      cfg.rate = r;
      saveCfg();
      applyAll();
      broadcastCfg();
      updatePanel();
      log('info', '倍速设为 ' + r + 'x');
    });

    els.vol.addEventListener('input', function () {
      cfg.volume = clamp(parseInt(els.vol.value, 10) / 100, 0, 1);
      applyAll();
      broadcastCfg();
      updatePanel();
    });
    els.vol.addEventListener('change', function () {
      saveCfg();
      log('info', '音量设为 ' + Math.round(cfg.volume * 100) + '%');
    });

    els.autoNext.addEventListener('change', function () {
      cfg.autoNext = els.autoNext.checked;
      saveCfg();
      broadcastCfg();
      log('info', '自动下一讲：' + (cfg.autoNext ? '恢复' : '暂停'));
      updatePanel();
    });

    els.autoPlay.addEventListener('change', function () {
      cfg.autoPlay = els.autoPlay.checked;
      saveCfg();
      broadcastCfg();
      log('info', '自动播放：' + (cfg.autoPlay ? '开' : '关'));
    });

    els.skipNoVideo.addEventListener('change', function () {
      cfg.skipNoVideo = els.skipNoVideo.checked;
      saveCfg();
      broadcastCfg();
      state.noVideoSince = 0;
      log('info', '无视频小节自动跳过：' + (cfg.skipNoVideo ? '开' : '关'));
      updatePanel();
    });

    els.nextBtn.addEventListener('click', function () {
      if (!state.running) { log('warn', '脚本已停止，请先点「启动」'); return; }
      if (state.nextState !== 'idle') { log('info', '切换进行中，请稍候'); return; }
      if (state.primary) {
        state.nextState = 'waiting';
        state.nextAttempts = 0;
        doNext('手动');
      } else {
        // 视频在 iframe 里：让子框架去点它自己的「下一讲」
        log('info', '已请求子框架切换下一讲');
        broadcast('next');
      }
    });

    els.rescan.addEventListener('click', function () {
      state.primary = null;
      state.active = null;
      clearTimeout(partTimer); partTimer = null;
      resetPartCache();
      state.lastCourseScan = 0;
      scheduleScan(0);
      broadcast('rescan');
      log('info', '手动重新扫描');
    });

    els.diag.addEventListener('click', function () {
      // 顺带向子框架要一份视频 / Part 结构，一并复制到剪贴板
      state.childDiag = null;
      broadcast('diag');
      setTimeout(function () {
        const d = collectDiagnostics();
        console.log('[HTAP] 诊断信息', d);
        log('info', '视频 ' + d.videos.length + ' / iframe ' + d.iframes.length +
          ' / canvas ' + d.canvas + ' / nextState ' + d.nextState +
          ' / 子框架视频 ' + (d.childDiag && d.childDiag.videos ? d.childDiag.videos.length : '?'));
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(JSON.stringify(d, null, 2)).then(function () {
              log('info', '诊断信息已复制到剪贴板');
            }, function () { /* 忽略 */ });
          }
        } catch (e) { /* 忽略 */ }
      }, 800);
    });

    els.stop.addEventListener('click', function () {
      if (state.running) {
        stopAutomation('用户点击停止');
        broadcast('stop');
      } else {
        startAutomation();
        broadcast('start');
      }
      updatePanel();
    });

    els.collapse.addEventListener('click', function () {
      els.bd.classList.toggle('hide');
      els.collapse.textContent = els.bd.classList.contains('hide') ? '+' : '−';
    });

    /* ---- 拖拽 ---- */
    let drag = null;
    els.hd.addEventListener('pointerdown', function (e) {
      if (e.target && e.target.closest && e.target.closest('button')) return;
      const r = panelHost.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      panelHost.style.right = 'auto';
      panelHost.style.left = r.left + 'px';
      panelHost.style.top = r.top + 'px';
      try { els.hd.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });
    els.hd.addEventListener('pointermove', function (e) {
      if (!drag) return;
      const x = clamp(e.clientX - drag.dx, 0, Math.max(0, innerWidth - 60));
      const y = clamp(e.clientY - drag.dy, 0, Math.max(0, innerHeight - 40));
      panelHost.style.left = x + 'px';
      panelHost.style.top = y + 'px';
    });
    els.hd.addEventListener('pointerup', function (e) {
      drag = null;
      try { els.hd.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });

    renderLog();
  }

  function renderLog() {
    if (!els.log) return;
    const recent = logBuf.slice(-4);
    let html = '';
    for (let i = 0; i < recent.length; i++) {
      const l = recent[i];
      const cls = l.level === 'error' ? 'error' : (l.level === 'warn' ? 'warn' : '');
      const text = (l.t + ' ' + l.msg).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      html += '<div class="' + cls + '">' + text + '</div>';
    }
    if (els.log.innerHTML !== html) els.log.innerHTML = html;
  }

  function setText(el, s) {
    if (el && el.textContent !== s) el.textContent = s;
  }

  function updatePanel() {
    if (!panelHost || !els.status) return;

    const child = state.child;
    const childFresh = !!(child && Date.now() - child.at < 5000);
    const hasVideo = !!state.primary || !!(childFresh && child.video);

    els.dot.className = 'dot ' + (!state.running ? 'off' : (hasVideo ? 'on' : ''));

    const volPct = Math.round(cfg.volume * 100);
    if (els.vol && els.vol.value !== String(volPct)) els.vol.value = String(volPct);
    setText(els.volLabel, volPct + '%');

    if (els.autoNext) els.autoNext.checked = !!cfg.autoNext;
    if (els.autoPlay) els.autoPlay.checked = !!cfg.autoPlay;
    if (els.skipNoVideo) els.skipNoVideo.checked = !!cfg.skipNoVideo;
    setText(els.stop, state.running ? '停止' : '启动');

    let statusText;
    let hint = '';

    if (!state.running) {
      statusText = '已停止（点「启动」恢复）';
    } else if (!state.primary && childFresh && child.video) {
      statusText = (child.paused ? '已暂停' : '播放中') + '（子框架） ' +
        fmtTime(child.t) + ' / ' + (child.d ? fmtTime(child.d) : '--:--') +
        ' · ' + (Math.round(child.rate * 100) / 100) + 'x · ' + Math.round(child.vol * 100) + '%';
      if (state.nextState === 'waiting' || state.nextState === 'clicked') {
        statusText += ' · 切换中…';
      }
    } else if (!state.primary && childFresh) {
      statusText = '（子框架）等待播放器…' + (cfg.skipNoVideo ? '（无视频将自动跳过）' : '');
    } else if (!state.primary) {
      const waited = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000));
      statusText = waited >= 15
        ? '⚠ 未找到视频播放器（已等待 ' + waited + 's）'
        : '等待播放器…（' + waited + 's）';
      if (waited >= 15) {
        hint = '本讲可能是图文内容；或播放器在其它跨域 iframe 里。点「诊断」查看 video/iframe 数量。';
      }
    } else {
      const v = state.primary;
      const dur = isFinite(v.duration) ? fmtTime(v.duration) : '--:--';
      const cur = fmtTime(v.currentTime || 0);
      statusText = (v.paused ? '已暂停 ' : '播放中 ') + cur + ' / ' + dur +
        ' · ' + (Math.round(v.playbackRate * 100) / 100) + 'x · ' + volPct + '%';
      if (state.nextState === 'waiting' || state.nextState === 'clicked') {
        statusText += ' · 切换中…';
      }
    }

    setText(els.status, statusText);
    setText(els.hint, hint);

    if (els.course) {
      const c = state.course || { title: '', active: '' };
      setText(els.course, (c.active ? c.active : c.title) || '');
    }
  }

  /* ------------------------------------------------------------------ *
   * 10. 诊断
   * ------------------------------------------------------------------ */
  // 子框架回报给主框架的结构快照（诊断按钮会把它一起复制到剪贴板）
  function childStructure() {
    const vids = collectVideos();
    const ordered = orderedVideos(partVideos(vids));
    const videos = [];
    for (let i = 0; i < ordered.length; i++) {
      const v = ordered[i];
      let r = null;
      try { r = v.getBoundingClientRect(); } catch (e) { r = null; }
      videos.push({
        top: Math.round(absTop(v)),
        size: r ? Math.round(r.width) + 'x' + Math.round(r.height) : '?',
        src: String(v.currentSrc || v.getAttribute('src') || '').slice(0, 50),
        t: Math.round((v.currentTime || 0) * 10) / 10,
        d: isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : 0,
        paused: v.paused,
        ended: v.ended,
        active: v === state.active
      });
    }

    const parts = [];
    try {
      const hs = getPartHeadings();
      for (let i = 0; i < hs.length; i++) {
        parts.push({ text: normText(hs[i].el).slice(0, 12), top: Math.round(hs[i].top) });
      }
    } catch (e) { /* 忽略 */ }

    const nextButtons = [];
    try {
      document.querySelectorAll('button, a, div, span').forEach(function (el) {
        if (el.children && el.children.length > 0) return;
        const t = normText(el);
        if (t !== '上一讲' && t !== '下一讲' && t !== '下一节') return;
        let r;
        try { r = el.getBoundingClientRect(); } catch (e) { return; }
        nextButtons.push({
          text: t,
          top: Math.round(r.top + (window.pageYOffset || 0)),
          left: Math.round(r.left),
          w: Math.round(r.width)
        });
      });
    } catch (e) { /* 忽略 */ }

    return {
      url: location.href,
      videos: videos,
      partHeadings: parts,
      nextButtons: nextButtons,
      activeTop: state.active ? Math.round(absTop(state.active)) : null
    };
  }

  function collectDiagnostics() {
    const videos = [];
    try {
      document.querySelectorAll('video').forEach(function (v) {
        videos.push({
          src: (v.currentSrc || v.getAttribute('src') || '').slice(0, 120),
          paused: v.paused,
          rate: v.playbackRate,
          volume: v.volume,
          readyState: v.readyState,
          visible: isVisible(v)
        });
      });
    } catch (e) { /* 忽略 */ }

    const iframes = [];
    try {
      document.querySelectorAll('iframe').forEach(function (f) {
        let sameOrigin = false;
        try { sameOrigin = !!f.contentDocument; } catch (err) { sameOrigin = false; }
        iframes.push({ src: (f.getAttribute('src') || '').slice(0, 120), sameOrigin: sameOrigin });
      });
    } catch (e) { /* 忽略 */ }

    let canvas = -1;
    try { canvas = document.querySelectorAll('canvas').length; } catch (e) { /* 忽略 */ }

    return {
      version: VERSION,
      topFrame: IS_TOP,
      url: location.href,
      running: state.running,
      config: cfg,
      videos: videos,
      iframes: iframes,
      canvas: canvas,
      primary: state.primary ? {
        rate: state.primary.playbackRate,
        volume: state.primary.volume,
        readyState: state.primary.readyState
      } : null,
      nextState: state.nextState,
      nextButtonFound: !!findNextButton(),
      activeTop: state.active ? Math.round(absTop(state.active)) : null,
      childDiag: state.childDiag || null,
      course: state.course,
      child: state.child,
      structure: IS_TOP ? null : childStructure(),
      log: logBuf.slice(-30)
    };
  }

  /* ------------------------------------------------------------------ *
   * 11. 初始化
   * ------------------------------------------------------------------ */
  let inputBound = false;
  function bindInput() {
    if (inputBound) return;
    inputBound = true;
    const markInput = function () { state.lastUserInputAt = Date.now(); };
    document.addEventListener('pointerdown', markInput, true);
    document.addEventListener('keydown', markInput, true);
  }

  function init() {
    bindInput();

    if (IS_TOP) {
      if (!document.body) { setTimeout(init, 300); return; }
      createPanel();
      window.addEventListener('hashchange', function () {
        if (location.href !== lastHref) onRouteChanged();
      });
      window.addEventListener('message', onTopMessage);
    } else {
      window.addEventListener('message', onChildMessage);
    }

    startAutomation();

    try {
      pageWindow.__HTAP__ = {
        version: VERSION,
        state: state,
        config: cfg,
        diagnostics: collectDiagnostics,
        start: startAutomation,
        stop: function () { stopAutomation('API'); },
        next: function () { requestNext('API'); },
        log: function () { return logBuf.slice(); }
      };
    } catch (e) { /* 忽略 */ }

    log('info', '已加载 ' + VERSION + (IS_TOP ? '（主框架）' : '（子框架）'));
  }

  // 等 DOM 就绪（document-idle 正常已就绪，这里只是兜底）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
