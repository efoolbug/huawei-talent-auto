/* ============================================================================
 * HuaweiTalentAuto · 诊断工具  v0.1.0
 * ----------------------------------------------------------------------------
 * 用途：在「华为人才在线」课程页面按 F12 → Console，整段粘贴后回车。
 * 性质：只读。不修改 DOM、不改样式、不拦截网络、不注入播放器逻辑。
 *       唯一的副作用是临时挂一个 MutationObserver 和 PerformanceObserver，
 *       2.5 秒后自动 disconnect；以及结尾在 window 上留一个 __HTAP_DIAG__ 结果对象。
 * 耗时：约 3 秒出结果。
 * 目标页：https://e.huawei.com/cn/talent/outPage/#/sxz-course/home
 * ========================================================================== */
(async function HTAP_DIAG() {
  'use strict';

  if (window.__HTAP_DIAG_RUNNING__) {
    console.warn('[HTAP] 诊断已在进行中，请稍候。');
    return;
  }
  window.__HTAP_DIAG_RUNNING__ = true;

  /* ---------------- 基础工具 ---------------- */
  const G = (fn, fb = null) => { try { return fn(); } catch (e) { return fb; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cut = (s, n = 110) => {
    s = s === null || s === undefined ? '' : String(s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  };
  const nameOf = (el) => {
    if (!el) return '(null)';
    if (el.nodeType === 3) return '(text)';
    let s = el.tagName ? el.tagName.toLowerCase() : String(el);
    if (el.id) s += '#' + el.id;
    if (el.classList && el.classList.length) {
      s += '.' + Array.from(el.classList).slice(0, 3).join('.');
    }
    return cut(s, 70);
  };
  const rectOf = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });

  const OUT = {
    tool: 'HuaweiTalentAuto/diagnose v0.1.0',
    ranAt: new Date().toISOString(),
    url: location.href,
    report: {}
  };

  /* ---------------- 1. 运行环境 ---------------- */
  const env = {
    href: location.href,
    hash: location.hash,
    userAgent: navigator.userAgent,
    chrome: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || null,
    topFrame: window.top === window,
    subFrameCount: window.length,
    readyState: document.readyState,
    viewport: innerWidth + 'x' + innerHeight,
    devicePixelRatio: devicePixelRatio,
    online: navigator.onLine,
    // 这三项用于判断脚本执行在哪个上下文：
    // 全部 undefined ⇒ 页面上下文里没有 GM API，1.0.0 很可能是 @grant none（高风险）
    GM_info: typeof GM_info,
    GM: typeof GM,
    unsafeWindow: typeof unsafeWindow
  };

  /* ---------------- 2. 渲染状态 ---------------- */
  const stylePick = (cs) => ({
    display: cs.display,
    visibility: cs.visibility,
    opacity: cs.opacity,
    overflow: cs.overflow,
    background: cs.backgroundColor,
    height: cs.height
  });

  const render = {
    title: document.title,
    bodyExists: !!document.body,
    bodyChildren: document.body ? document.body.children.length : -1,
    bodyTextLen: document.body ? (document.body.innerText || '').trim().length : -1,
    scrollHeight: document.documentElement.scrollHeight,
    roots: [],
    htmlStyle: G(() => stylePick(getComputedStyle(document.documentElement)), {}),
    bodyStyle: G(() => stylePick(getComputedStyle(document.body)), {})
  };

  ['#app', '#root', '[data-v-app]', '#main', 'main', '.app', '.layout'].forEach((sel) => {
    const el = G(() => document.querySelector(sel));
    if (!el) return;
    const cs = G(() => getComputedStyle(el), null);
    render.roots.push({
      sel,
      name: nameOf(el),
      children: el.children.length,
      textLen: (el.innerText || '').trim().length,
      rect: rectOf(el.getBoundingClientRect()),
      display: cs ? cs.display : null,
      visibility: cs ? cs.visibility : null,
      opacity: cs ? cs.opacity : null
    });
  });

  /* ---------------- 3. 遮挡层扫描（"白屏"最常见真凶） ---------------- */
  const vw = innerWidth;
  const vh = innerHeight;
  const vArea = Math.max(1, vw * vh);
  const overlays = [];

  const allEls = G(() => Array.from(document.querySelectorAll('body *')), []);
  for (const el of allEls) {
    // 先用几何尺寸粗筛（便宜），再算 computedStyle（昂贵），避免在超大 DOM 上制造长任务
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { continue; }
    const area = r.width * r.height;
    if (area < vArea * 0.35) continue;
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { continue; }
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
    overlays.push({
      el: nameOf(el),
      zIndex: cs.zIndex,
      position: cs.position,
      pointerEvents: cs.pointerEvents,
      background: cs.backgroundColor,
      opacity: cs.opacity,
      areaPct: Math.round((area / vArea) * 100),
      rect: rectOf(r)
    });
    if (overlays.length >= 15) break;
  }
  overlays.sort((a, b) => b.areaPct - a.areaPct);

  const points = [
    ['center', vw / 2, vh / 2],
    ['top-left', 10, 10],
    ['top-right', vw - 10, 10],
    ['bottom-left', 10, vh - 10],
    ['upper-third', vw / 2, vh / 3]
  ];
  const hitTest = points.map(([label, x, y]) => {
    const el = G(() => document.elementFromPoint(x, y), null);
    return { at: label, top: el ? nameOf(el) : '(null)', isBodyLike: !!el && /^(html|body)$/i.test(el.tagName) };
  });

  /* ---------------- 4. 媒体 / iframe / Shadow DOM 探测 ---------------- */
  const media = {
    videos: [],
    iframes: [],
    shadowHosts: [],
    canvases: G(() => document.querySelectorAll('canvas').length, 0),
    playerLibs: [],
    blobSources: []
  };
  const seenVideos = new Set();

  function describeVideo(v, framePath) {
    return {
      frame: framePath,
      src: cut(v.currentSrc || v.getAttribute('src') || '(none)', 90),
      paused: v.paused,
      readyState: v.readyState,
      networkState: v.networkState,
      currentTime: Math.round((v.currentTime || 0) * 10) / 10,
      duration: isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : null,
      playbackRate: v.playbackRate,
      muted: v.muted,
      volume: Math.round(v.volume * 100) / 100,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      inShadow: !!(v.getRootNode && v.getRootNode().host),
      visible: !!(v.offsetWidth || v.offsetHeight || v.getClientRects().length),
      error: v.error ? { code: v.error.code, message: cut(v.error.message, 80) } : null
    };
  }

  function walk(root, path, depth) {
    if (!root || depth > 3) return;

    const vids = G(() => Array.from(root.querySelectorAll('video')), []);
    for (const v of vids) {
      if (seenVideos.has(v)) continue;
      seenVideos.add(v);
      media.videos.push(describeVideo(v, path));
    }

    const nodes = G(() => Array.from(root.querySelectorAll('*')), []);
    for (const el of nodes) {
      if (!el.shadowRoot) continue;
      media.shadowHosts.push({ host: nameOf(el), frame: path });
      walk(el.shadowRoot, path + ' > shadow:' + nameOf(el), depth + 1);
    }

    if (root === document) {
      for (const f of document.querySelectorAll('iframe')) {
        const rec = {
          frame: nameOf(f),
          src: cut(f.getAttribute('src') || f.getAttribute('data-src') || '(no src)', 120),
          sameOrigin: null,
          videosInside: null,
          shadowInside: null,
          note: ''
        };
        let doc = null;
        try {
          doc = f.contentDocument;
          rec.sameOrigin = !!doc;
        } catch (e) {
          doc = null;
          rec.sameOrigin = false;
        }
        if (!doc) rec.note = '跨域或未加载：主文档脚本无法访问其 DOM（需单独在该 iframe 域注入）';
        if (doc) {
          rec.videosInside = G(() => doc.querySelectorAll('video').length, 0);
          rec.shadowInside = G(() => Array.from(doc.querySelectorAll('*')).filter((e) => e.shadowRoot).length, 0);
          walk(doc, path + ' > iframe[' + rec.frame + ']', depth + 1);
        }
        media.iframes.push(rec);
      }
    }
  }
  walk(document, 'main', 0);

  // 常见播放器库特征
  [
    ['video.js', '.video-js'],
    ['xgplayer(西瓜)', '.xgplayer'],
    ['Aliplayer', '.prism-player'],
    ['DPlayer', '.dplayer'],
    ['Plyr', '.plyr'],
    ['ckplayer', '.ckplayer'],
    ['polyv', '.polyv, .plv-player']
  ].forEach(([lib, sel]) => {
    const n = G(() => document.querySelectorAll(sel).length, 0);
    if (n) media.playerLibs.push({ lib, count: n });
  });

  // blob: / m3u8 / http 源
  G(() => {
    document.querySelectorAll('video, source').forEach((v) => {
      const s = v.currentSrc || v.src || v.getAttribute('src') || '';
      if (s) media.blobSources.push(cut(s, 90));
    });
    media.blobSources = Array.from(new Set(media.blobSources)).slice(0, 10);
  }, null);

  /* ---------------- 5. "上一讲 / 下一讲"按钮候选 ---------------- */
  const navButtons = G(() => {
    const cands = Array.from(
      document.querySelectorAll('button, a, [role="button"], div[class*="btn"], span[class*="btn"], i[class*="btn"]')
    );
    return cands
      .filter((el) => {
        const txt = (el.innerText || el.getAttribute('aria-label') || el.title || '').trim();
        return /下一讲|下一节|下节|下一课|next/i.test(txt);
      })
      .slice(0, 10)
      .map((el) => ({
        text: cut((el.innerText || '').trim(), 20),
        el: nameOf(el),
        disabled:
          el.disabled === true ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.classList.contains('disabled') ||
          el.classList.contains('is-disabled'),
        visible: !!(el.offsetWidth || el.offsetHeight)
      }));
  }, []);

  /* ---------------- 6. 性能：长任务 / DOM 变更风暴 / FPS ---------------- */
  const perf = {
    readyState: document.readyState,
    navigation: G(() => {
      const n = performance.getEntriesByType('navigation')[0];
      if (!n) return null;
      return {
        responseEnd: Math.round(n.responseEnd),
        domContentLoaded: Math.round(n.domContentLoadedEventEnd),
        load: Math.round(n.loadEventEnd)
      };
    }, null),

    resources: (() => {
      const res = G(() => performance.getEntriesByType('resource'), []);
      return {
        count: res.length,
        lastScripts: res.filter((r) => r.initiatorType === 'script').slice(-12).map((r) => cut(r.name, 100)),
        failed: res.filter((r) => (r.responseStatus || 0) >= 400).slice(0, 15)
          .map((r) => ({ status: r.responseStatus, url: cut(r.name, 100) }))
      };
    })()
  };

  let longTaskMs = [];
  let po = null;
  try {
    po = new PerformanceObserver((list) => {
      longTaskMs = longTaskMs.concat(list.getEntries().map((e) => Math.round(e.duration)));
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch (e) { /* 不支持则忽略 */ }

  let mutRecords = 0;
  let mutNodes = 0;
  const mutTargets = new Map();
  const mo = new MutationObserver((list) => {
    mutRecords += list.length;
    for (const m of list) {
      mutNodes += m.addedNodes.length + m.removedNodes.length;
      const t = m.target && m.target.nodeType === 1
        ? nameOf(m.target)
        : (m.target && m.target.parentElement ? nameOf(m.target.parentElement) : '(text)');
      mutTargets.set(t, (mutTargets.get(t) || 0) + 1);
    }
  });
  G(() => mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true }), null);

  let frames = 0;
  let rafOn = true;
  const t0 = performance.now();
  (function tick() {
    frames++;
    if (rafOn && performance.now() - t0 < 2500) requestAnimationFrame(tick);
  })();

  await sleep(2500);
  rafOn = false;
  G(() => mo.disconnect(), null);
  G(() => po && po.disconnect(), null);

  perf.mutations = {
    recordsIn2_5s: mutRecords,
    nodesChangedIn2_5s: mutNodes,
    perSecond: Math.round(mutRecords / 2.5),
    topTargets: Array.from(mutTargets.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8)
  };
  perf.longTasks = {
    count: longTaskMs.length,
    totalMs: longTaskMs.reduce((a, b) => a + b, 0),
    maxMs: longTaskMs.length ? Math.max.apply(null, longTaskMs) : 0
  };
  perf.fps = Math.round(frames / 2.5);

  /* ---------------- 7. 框架 / 存储 ---------------- */
  const framework = {
    vue2: !!window.Vue || !!G(() => document.querySelector('#app') && document.querySelector('#app').__vue__, false),
    vue3: !!G(() => document.querySelector('#app') && document.querySelector('#app').__vue_app__, false),
    react: !!(window.React || G(() => {
      const r = document.querySelector('#root');
      return !!r && Object.keys(r).some((k) => k.indexOf('__reactContainer') === 0);
    }, false)),
    angular: !!(window.angular || window.ng || G(() => document.documentElement.getAttribute('ng-version'), null)),
    jquery: !!window.jQuery
  };

  const storage = {
    localStorageKeys: G(() => Object.keys(localStorage).slice(0, 40).map((k) => k + ' [' + String(localStorage.getItem(k)).length + ' chars]'), []),
    sessionStorageKeys: G(() => Object.keys(sessionStorage).slice(0, 40).map((k) => k + ' [' + String(sessionStorage.getItem(k)).length + ' chars]'), []),
    cookieNames: cut(G(() => document.cookie.split(';').map((s) => s.trim().split('=')[0]).filter(Boolean).join(', '), ''), 300)
  };

  /* ---------------- 8. 汇总判定 ---------------- */
  const verdict = [];
  if (overlays.length) {
    verdict.push('⚠️ 发现全屏遮挡层 ' + overlays.length + ' 个，最大者 ' + overlays[0].el +
      '（覆盖 ' + overlays[0].areaPct + '% 视口，z-index=' + overlays[0].zIndex + '）→ 很可能就是"白屏"本身');
  }
  if (perf.mutations.perSecond > 800) {
    verdict.push('⚠️ DOM 变更风暴：约 ' + perf.mutations.perSecond + ' 条/秒，首要目标 ' +
      (perf.mutations.topTargets[0] ? perf.mutations.topTargets[0][0] : '-') + ' → 疑似 Observer 自激循环');
  }
  if (perf.fps < 20) verdict.push('⚠️ 主线程严重阻塞：实测 ' + perf.fps + ' fps');
  if (perf.longTasks.maxMs > 300) verdict.push('⚠️ 超长任务：最长 ' + perf.longTasks.maxMs + ' ms');
  if (render.bodyChildren <= 0 || (render.roots.length && render.roots[0].children === 0)) {
    verdict.push('⚠️ 应用根节点为空 → SPA 未渲染（脚本报错 / 路由组件崩溃）');
  }
  if (render.bodyStyle && (render.bodyStyle.display === 'none' || render.bodyStyle.visibility === 'hidden')) {
    verdict.push('⚠️ body 被隐藏（display/visibility）→ 有样式在等某个条件');
  }
  if (!media.videos.length && media.iframes.length) {
    verdict.push('ℹ️ 主文档无 <video>，视频可能在 iframe 内（已列出可访问性）');
  }
  if (!media.videos.length && media.canvases) {
    verdict.push('ℹ️ 存在 canvas，播放器可能是 Canvas 自绘，不能按原生 video 处理');
  }
  if (env.GM_info === 'undefined' && env.GM === 'undefined') {
    verdict.push('ℹ️ 页面上下文无 GM API：若 1.0.0 声明了 @grant none，则它直接跑在页面全局作用域（声明冲突高风险）');
  }
  if (!verdict.length) verdict.push('✅ 本次采样未发现明显异常');

  OUT.report = { env, render, overlays, hitTest, media, navButtons, perf, framework, storage, verdict };

  /* ---------------- 9. 输出 ---------------- */
  const title = '[HuaweiTalentAuto] 诊断报告 v0.1.0';
  console.log('%c' + title, 'font-weight:bold;font-size:14px;color:#0a7');

  console.group('① 环境 / 执行上下文');
  console.table([env]);
  console.groupEnd();

  console.group('② 渲染状态');
  console.log('title:', render.title, '| readyState:', perf.readyState,
    '| body 子元素:', render.bodyChildren, '| body 文本长度:', render.bodyTextLen,
    '| 页面高度:', render.scrollHeight);
  console.log('html:', render.htmlStyle);
  console.log('body:', render.bodyStyle);
  if (render.roots.length) console.table(render.roots);
  else console.log('未找到 #app / #root / main 等应用根节点');
  console.groupEnd();

  console.group('③ 遮挡层（覆盖≥35% 视口）');
  if (overlays.length) console.table(overlays);
  else console.log('无遮挡元素');
  console.table(hitTest);
  console.groupEnd();

  console.group('④ 媒体 / iframe / Shadow DOM');
  console.log('video 数:', media.videos.length,
    '| iframe 数:', media.iframes.length,
    '| shadow host 数:', media.shadowHosts.length,
    '| canvas 数:', media.canvases);
  if (media.videos.length) console.table(media.videos);
  if (media.iframes.length) console.table(media.iframes);
  if (media.shadowHosts.length) console.table(media.shadowHosts);
  if (media.playerLibs.length) console.table(media.playerLibs);
  if (media.blobSources.length) console.log('媒体源:', media.blobSources);
  console.groupEnd();

  console.group('⑤ 下一讲按钮候选');
  if (navButtons.length) console.table(navButtons);
  else console.log('未按文本匹配到"下一讲"，需要手工在 Elements 面板确认');
  console.groupEnd();

  console.group('⑥ 性能');
  console.log('FPS:', perf.fps);
  console.log('长任务:', perf.longTasks);
  console.log('DOM 变更:', perf.mutations);
  console.log('导航时序:', perf.navigation);
  console.log('资源总数:', perf.resources.count);
  if (perf.resources.failed.length) console.table(perf.resources.failed);
  console.groupEnd();

  console.group('⑦ 框架 / 登录态');
  console.table([framework]);
  console.log('localStorage:', storage.localStorageKeys);
  console.log('sessionStorage:', storage.sessionStorageKeys);
  console.log('cookies:', storage.cookieNames);
  console.groupEnd();

  console.group('%c⑧ 自动判定', 'font-weight:bold;color:#c60');
  verdict.forEach((v) => console.log(v));
  console.groupEnd();

  window.__HTAP_DIAG__ = OUT;
  window.__HTAP_DIAG_RUNNING__ = false;
  console.log('%c完整结果对象：window.__HTAP_DIAG__（右键 → Copy object 发给开发者）',
    'color:#0a7;font-weight:bold');
})().catch((e) => {
  window.__HTAP_DIAG_RUNNING__ = false;
  console.error('[HTAP] 诊断异常：', e);
});
