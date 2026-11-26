# 01 · 1.0.0 页面空白：故障分析与诊断

> 状态：**分析完成，等待现场数据确认**
> 版本：1.0.0 → 待修复
> 目标页：`https://e.huawei.com/cn/talent/outPage/#/sxz-course/home`

---

## 0. 前置说明（必须先看）

1. **本机没有 1.0.0 的源码。** 检查了工作目录、Desktop 与 Downloads，未找到 `*.user.js`。
   没有源码就无法做行级审计，所以本文的每个结论都标注了"如何用现场数据证实/证伪"，
   而不是凭空断定。请把 1.0.0 源码放到 `legacy/huawei-talent-auto-1.0.0.user.js`，
   我就能把它和下面的假设逐条对号入座。
2. **`e.huawei.com` 需要登录，我这边无法访问该页面**，所有 DOM 结论都必须由你在真实页面上跑诊断得出。
   这也正是本文附送诊断脚本的原因。
3. 题目里"不要假设使用原生 video 播放器"是正确的：诊断脚本会分别统计
   主文档 / 跨域 iframe / 同源 iframe / Shadow DOM / Canvas 中的播放器。

---

## 1. 症状 → 机制的映射

| 症状 | 说明什么 |
|---|---|
| 页面主体空白 | 要么 SPA 根节点没渲染，要么被一层东西盖住了 |
| 标签页图标一直转圈 | 文档从未进入 `load` 完成态；或主线程被长期占满，加载事件迟迟发不出 |
| Tampermonkey 图标正常、脚本已启用 | 扩展本身没问题，排除了"TM 崩了" |
| 刷新后依旧 | 不是一次性的竞态，是可稳定复现的确定性故障 |

**关键推理**：一个用户脚本如果只是"抛个异常就结束"，页面通常照常加载。
能同时造成"空白 + 一直转圈"的，只有三类：

- **A. 主线程被占满**（死循环 / Observer 自激 / 密集定时器）→ 浏览器的渲染与 load 事件都推不动；
- **B. 页面自己的入口 bundle 挂了**（全局声明冲突、原生原型被改写）→ SPA 外壳在，但路由组件永远不挂载；
- **C. 根本没空白，是被遮住了**（全屏浮层 / `body{visibility:hidden}`）→ 转圈其实来自某些挂起的请求。

下面 8 个假设按上述三类归并，并按"与你症状的吻合度"排序。

---

## 2. 假设清单（按优先级）

### H1 ★★★★★ 全局词法声明冲突（`@grant none` + `document-start`）

**机制**：`@grant none` 时 Tampermonkey 把脚本直接注入页面全局作用域，**不建沙箱**。
如果 1.0.0 顶层写了 `const state = ...` / `let config` / `class Player` / `const Video`，
这些名字会和站点 bundle 的顶层声明落在**同一个全局词法环境**里。
一旦重名，V8 在解析阶段直接抛
`Uncaught SyntaxError: Identifier 'xxx' has already been declared`，
**站点入口脚本整段不执行** → SPA 骨架在、路由组件不挂载 → 主体空白；
而入口 bundle 之后的请求永远不会发起/结束 → 标签页一直转圈。

**为什么排第一**：它同时解释"空白"和"一直转圈"，且是这类脚本最常见的事故。
典型撞名：`state`、`config`、`app`、`router`、`store`、`player`、`Video`、`Panel`、`log`、`main`、`util`。

**验证**：
- Console 里往上翻，搜 `already been declared`；
- 诊断报告 ① 中 `GM_info` / `GM` 都是 `undefined` ⇒ 1.0.0 是 `@grant none`，高危；
- 快速反证：把头部 `@grant none` 改成 `@grant GM_info` 再刷新 —— 若恢复正常，基本确诊。

**修复方向**：整个脚本包进 IIFE，`@grant GM_info`（或任一真实授权）强制沙箱；
禁止任何顶层 `const/let/class`。

---

### H2 ★★★★☆ 全屏遮挡层 / body 被隐藏

**机制**：浮层面板写成 `position:fixed; inset:0; background:#fff; z-index:2147483647`，
或在"等播放器出现"期间给 `body` 加了 `visibility:hidden` / `opacity:0`。
视觉上是纯白，用户判定为"页面没加载"，但网络其实正常。

**为什么高**：需求里要做"悬浮控制面板"，而 1.0.0 的面板 CSS 很可能没约束尺寸；
很多人还会加"加载遮罩"。

**验证**：诊断报告 ③。看 `overlays` 表与 `hitTest`：
若视口中心 `elementFromPoint` 命中的不是 `body`，而是某个 `div#xxx`，就是它。

---

### H3 ★★★★☆ MutationObserver 自激循环

**机制**：`observer.observe(document.body, {childList:true, subtree:true})`，
回调里又写 DOM（更新面板文字、给 video 加属性、插标记节点）→ 产生新记录 → 再进回调。
TM 的回调是微任务级调度，很容易形成每秒上万次的循环，**主线程 100% 占用**。
症状：页面画完首屏后冻结、点击无响应、标签页常驻转圈。

**为什么高**：1.0.0 明确"每秒检测 + subtree 全量观察"，这正是该 bug 的温床。
注意：即使回调只是 `console.log`，在高频站点上也会明显拖慢。

**验证**：诊断报告 ⑥ 的 `mutations.perSecond`；>800 起疑，>3000 基本确诊。
`topTargets` 会告诉你风暴中心是哪个节点（若指向面板自身，即 H3 实锤）。
另可用 DevTools Performance 录 3 秒，看是否出现锯齿状连续长任务。

---

### H4 ★★★★☆ 改写原生媒体/XHR 原型，导致路由组件崩溃

**机制**：为"自动播放/加速"，脚本改了 `HTMLMediaElement.prototype.play`、
`playbackRate` 的 setter、`MediaSource` 或 `XMLHttpRequest`。
站点播放器初始化时调用被改坏的 API 抛错 → Vue/React 路由组件渲染中断 →
内容区空白（但外壳还在）。这类错误通常只在 Console 里留一条红色堆栈，不阻止文档 `load`。

**验证**：Console 是否有指向 `video` / `player` / `hls` 模块的报错；
诊断报告 ② 若 `#app` 存在但 `children === 0`，且 ⑥ 的 FPS 正常（区别于 H3），倾向 H4。

**修复方向**：**永远不要**改原型。只在具体 `<video>` 实例上设 `playbackRate` / `volume`。

---

### H5 ★★★☆☆ `@match` 过宽 + 缺 `@noframes`

**机制**：`@match https://e.huawei.com/*` 且无 `@noframes`，脚本在每个匹配的 frame 里各跑一份：
主文档 + 统计 iframe + 播放器 iframe …… 每个都挂 Observer 和 1s 定时器，
开销成倍放大，且面板会出现在不该出现的地方。若某段代码在子 frame 里做了
`document.write` 或大改 DOM，该 frame 直接白屏；命中应用外壳则整页白屏。

**验证**：诊断报告 ① 的 `subFrameCount`、④ 的 `iframes` 列表。
再看 DevTools 顶部 frame 选择器里，是否多个 frame 都有 TM 的注入痕迹。

**修复方向**：`@noframes` + 精确 `@match`；确需进 iframe 时单独写一个只在
播放器域生效的脚本。

---

### H6 ★★★☆☆ 密集轮询 / 同步阻塞

**机制**：`setInterval(fn, 0~50)` 里做 `querySelectorAll('*')` 或遍历大 DOM；
或某处 `while` 等待条件成立。诊断报告 ⑥ 的 FPS 会明显掉到个位数。

**验证**：FPS < 20 且长任务密集；`Performance` 面板里能看到固定周期的长条。

---

### H7 ★★☆☆☆ 站点自身问题（必须先排除）

登录态过期、灰度发布、区域策略、CSP、公司网络拦截，都会造成同样现象。
**这一步必须在禁用 1.0.0 的情况下先做**，否则后面所有分析都可能是"给别人的 bug 找原因"。

**验证**：TM 里禁用脚本 → `Ctrl+Shift+R` 硬刷新 → 页面正常吗？
- 正常 ⇒ 确认是脚本引起，进入第 3 节二分定位；
- 仍空白 ⇒ 先查站点本身（Network 里红色请求、Console 首屏报错、换个浏览器/账号）。

---

### H8 ★☆☆☆☆ `document-start` 早期访问 `document.body` 为 null

单独出现只会让脚本自己报 `Cannot read properties of null`，不会白屏；
但它常与 H1/H3 组合出现。诊断探针（`probe.user.js`）会记录 body 就绪时间。

---

## 3. 定位流程

### 3.1 三分钟快速分诊

```
1. TM 禁用 1.0.0 → Ctrl+Shift+R
   ├─ 页面正常  → 脚本问题，走 3.2
   └─ 仍空白    → 站点/网络问题，先解决站点，脚本无罪

2. 在空白页 Console 粘贴 tools/diagnose.console.js 全文 → 回车
   读 ⑧ 自动判定：
   ├─ 有"遮挡层"          → H2
   ├─ mutation 每秒 >800  → H3
   ├─ FPS < 20            → H3 / H6
   ├─ 根节点为空 + FPS 正常→ H1 / H4
   └─ 一起正常            → H7，换无痕窗口 + 重新登录再测
```

> 注意：诊断要在 **1.0.0 启用** 的状态下跑，否则测不到它造成的影响。
> 想对比"有没有脚本"的差异，用 `tools/probe.user.js` 各跑一次（详见第 4 节）。

### 3.2 不用读源码的二分定位（推荐）

在 TM 编辑器里只做 `return;` 插入，**不改任何逻辑**，每步硬刷新：

| 步骤 | 改动 | 若恢复正常 ⇒ 结论 |
|---|---|---|
| 1 | 脚本体第一行插入 `return;` | 脚本体是元凶（继续） |
| 2 | 删掉 `return;`，把 `@grant none` 改成 `@grant GM_info` | **H1** 全局声明冲突 |
| 3 | `@run-at document-start` 改成 `document-idle` | 执行时机过早 |
| 4 | 头部加 `// @noframes` | **H5** 多 frame 注入 |
| 5 | 注释掉面板注入那几行 | **H2** 遮挡层 |
| 6 | 注释掉 `observer.observe(...)` | **H3** Observer |
| 7 | 注释掉所有 `prototype` / `defineProperty` 相关代码 | **H4** 原型改写 |
| 8 | 在脚本体 1/2、1/4、1/8 处插 `return;` 二分 | 锁定具体代码块 |

> 每一步只改一处，改完 `Ctrl+Shift+R`。哪一步恢复，就锁定了那一类原因。
> 这是"不盲目修改"的标准做法：先定位，再动手。

---

## 4. 诊断工具用法

### 4.1 `tools/diagnose.console.js` —— 现场快照

- 在课程页 F12 → Console → 整段粘贴 → 回车，约 3 秒。
- **只读**：不改 DOM、不改样式、不拦网络。临时挂的 Observer 2.5s 后自动断开。
- 输出 8 组：环境、渲染状态、遮挡层、媒体/iframe/Shadow、下一讲按钮候选、
  性能、框架/登录态、自动判定。
- 结果同时挂到 `window.__HTAP_DIAG__`，右键 *Copy object* 即可整包发给我。

### 4.2 `tools/probe.user.js` —— 加载时间线探针

- 装为独立 TM 脚本（`@run-at document-start`，`@grant GM_info` 强制沙箱，`@noframes`）。
- 记录：body 就绪时间、`#app` 首次渲染时间、首个 `<video>` 出现时间、
  未捕获异常、长任务、hash 路由变化。
- **关键实验**：
  1. 禁用 1.0.0，只装探针 → 记录"基线"；
  2. 启用 1.0.0 → 再记录一次；
  3. 对比两次的 `firstAppRenderedMs`、`errors`、`longTaskMax`。
  - 启用后 `firstAppRenderedMs` 变 `null` 或大幅推迟 ⇒ 脚本阻塞了渲染（H1/H3）；
  - 启用后 `errors` 里出现 `SyntaxError` ⇒ H1 实锤。

### 4.3 需要你回传的三样东西

1. `window.__HTAP_DIAG__` 的 JSON；
2. 1.0.0 源码（放到 `legacy/`），或直接贴给我；
3. 从 `Ctrl+Shift+R` 开始到页面稳定的完整 Console 截图（勾选 *Preserve log*）。

---

## 5. 关于目标页的结构推断（待现场证实）

`/cn/talent/outPage/#/sxz-course/home` 中，**路由在 hash 里**，文档地址其实是
`https://e.huawei.com/cn/talent/outPage/`。由此可确定：

- `document-idle` 只能保证"外壳就绪"，**课程内容与播放器一定晚于它出现**；
- 必须监听 `hashchange` 与 `pushState/replaceState`（站点可能用 history 路由切课）；
- `@match` 应覆盖 `https://e.huawei.com/cn/talent/*`，注意 hash 不参与匹配；
- 播放器很可能在 `sxz-course` 路由组件内部，**动态创建、切课时销毁重建**，
  因此必须按"播放器实例变了"来处理参数重设，而不是"页面加载时设一次"。

这些都会在第二阶段的设计里直接用上，但**具体是 `<video>` 还是 iframe/Canvas，以诊断结果为准**。

---

## 6. 第二阶段（概要，待确认原因后展开）

架构要点（详细实现等第 4.3 节材料到齐后给出）：

```
manifest.user.js   ← 单文件可安装（TM 不支持多文件，构建期拼接）
├── core/
│   ├── env.js          沙箱/框架/页面识别
│   ├── route.js        hashchange + history 钩子 + 轮询兜底（三重保险）
│   ├── player.js       发现 <video>（含 Shadow DOM / 同源 iframe），实例去重
│   ├── controller.js   应用倍速/音量/自动播放，实例级不碰原型
│   ├── next.js         监听 ended → 点击原生"下一讲" → 单次触发锁
│   ├── guard.js        无法识别播放器时的明确提示 + 诊断入口
│   └── log.js          环形日志（不 console 刷屏）
└── ui/panel.js         小尺寸可拖拽面板，绝不覆盖整页
```

三条硬约束会写进设计：

1. **绝不改原型、绝不碰 `MediaSource`**；
2. **Observer 回调绝不写被观察的子树**（面板挂 `document.documentElement` 之外或用过滤条件）；
3. **`ended` 触发用一次性锁 + 导航确认**，杜绝无限切课。

---

## 7. 合规边界（会写进最终脚本与 README）

- 只做：倍速、音量、播放、按站内原生按钮切下一讲、可视化开关。
- 不做：伪造学习时长、伪造完成状态、绕过考核/人脸/防挂机检测。
- 提示：部分平台会对倍速播放做时长折算或风控，启用高倍速可能导致学时不计。
  这属于站点策略，脚本不会去规避；请按自身培训规定使用。
