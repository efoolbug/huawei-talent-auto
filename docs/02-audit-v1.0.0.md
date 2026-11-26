# 02 · 1.0.0 源码审计：页面空白的根因与 2.0.0 修复

> 结论：**MutationObserver 自激循环**，已由源码确证，无需再靠现场采样推断。
> 修复产物：`huawei-talent-auto.user.js`（单文件，可直接安装）

---

## 1. 根因

1.0.0 第 9 段：

```js
const observer = new MutationObserver(() => {
    monitor();
});

observer.observe(document.body, {
    childList: true,
    subtree: true
});
```

`monitor()`（第 8 段）在任何分支上都会写面板文本：

```js
function monitor() {
    const video = findVideo();
    if (!video) {
        status('等待视频加载');   // ← 写 #hta-status.textContent
        return;
    }
    ...
    setVideoConfig(video);       // ← 写 #hta-speed / #hta-volume.textContent
}
```

而面板是第 10 段之前 `document.body.appendChild(panel)` 挂进 body 的，**正好落在被观察的子树里**。

闭环：

```
写 panel 文本 → 产生 childList mutation → observer 回调 → monitor()
   → 再写 panel 文本 → 再产生 mutation → …∞
```

两个让它必然成立的细节：

1. `textContent = "相同字符串"` **仍然**会删除旧文本节点、插入新节点，每次都是一条
   childList 记录。不会因为"内容没变"而被浏览器优化掉。
2. MutationObserver 回调以 **microtask** 派发；回调里同步制造的新 mutation 会再次排队。
   微任务队列永远清不空 → 事件循环无法进入渲染/任务阶段。

所以不只是"卡"，是**主线程被永久占满**：

| 现象 | 机制 |
|---|---|
| 主体空白 | 首帧之前就卡死，SPA 路由组件没有机会渲染 |
| 标签页一直转圈 | `load` 事件发不出来（渲染与任务都被饿死） |
| TM 图标正常 | 扩展本身没坏 |
| 强制刷新也一样 | 确定性故障，不是竞态 |
| `setInterval(monitor, 1000)` | 第二条写入路径，即使 observer 被绕过也会持续制造 mutation |

补充：站点自身的任何 DOM 更新（路由渲染、Vue/React 更新）也会触发 observer → monitor()
→ 写面板 → 更多 mutation，等于给循环持续"加油"。

---

## 2. 对第一阶段其他假设的排除

基于源码逐条核对，以下假设**不成立**：

| 假设 | 结论 | 依据 |
|---|---|---|
| H1 `@grant none` 全局声明冲突 | **排除** | 全部代码包在 `(function(){...})()` 里，没有顶层 `const/let/class` 泄漏到页面作用域 |
| H2 全屏遮挡层 / body 隐藏 | **排除** | 面板 `min-width:180px`、`position:fixed` 小方块；脚本从不改 `body` 样式 |
| H4 改写原生媒体原型 | **排除** | 只读/写 `video.playbackRate`、`video.volume` 实例属性，没有任何 `prototype` 操作 |
| H5 `@match` 过宽多重注入 | **影响有限** | `@match .../outPage/*` 已较窄；且即使多 frame 注入，也仍是同一个循环问题 |
| H7 站点自身问题 | **需你 30 秒确认** | 禁用脚本后刷新正常即排除 |

H3 从"最高嫌疑"升级为**唯一根因**。

---

## 3. 2.0.0 的对应修复

| 问题 | 2.0.0 做法 | 代码位置 |
|---|---|---|
| 观察器回调写 DOM | 回调**只置 debounce 定时器**，扫描函数全程只读；扫描结果只写 Shadow DOM 与控制台 | `attachObserver()` |
| 面板自身在观察范围内 | 面板放进 `attachShadow({mode:'open'})`，其内部节点**不属于文档树**，任何文字更新都不会产生文档 mutation | `createPanel()` |
| 重复写相同文本 | 所有面板文本更新走 `setText()`，值相同不写 | `setText()` / `renderLog()` |
| 1 秒轮询重设参数 | 改为事件驱动（`loadedmetadata` / `canplay` / `play` / `seeked` / `ratechange`）+ 500ms 只读扫描 | `bindVideo()` |
| 无限切课 | 一次性锁 `nextState` + `ended` 去重 `__htapEndedHandled` + 点击后 15s 导航确认 + 最多重试 1 次 + 失败后 30s 冷却 | `requestNext()` / `doNext()` / `watchNavChange()` / `failNext()` |
| 播放器在 iframe | 不再 `@noframes`；每个 frame 各自控制自己的 `<video>`，子 frame 的 `ended` 用 `postMessage` 转给主 frame（校验 `e.source` 是否为本站 frame） | `sendToTop()` / `onTopMessage()` |
| 无法识别播放器 | 15s 后在面板给出明确提示 + 「诊断」按钮输出 video/iframe/canvas 数量并复制 JSON | `updatePanel()` / `collectDiagnostics()` |
| SPA 路由 | `hashchange` + 500ms `location.href` 比对 + MutationObserver 三重触发，路由变化后重置切课状态并重扫 | `onRouteChanged()` / `checkRoute()` |
| 停止不干净 | 断开 observer、清全部定时器、还原播放器原始倍速/音量/muted、通知子 frame | `stopAutomation()` / `restoreVideos()` |

### 为什么"Shadow DOM + 只读回调"是结构性修复，而不是打补丁

只要满足下面任意一条，循环就不可能再发生：

- 回调里没有任何 DOM 写入（现在满足）；
- 写入目标不在观察子树内（Shadow DOM 满足）。

2.0.0 两条都满足。即使将来有人往回调里加日志，只要写的是 Shadow DOM，也不会重新引爆。

---

## 4. 验证清单（对应 15 条需求）

| # | 需求 | 验证方法 | 预期 |
|---|---|---|---|
| 0 | 网站正常加载 | 安装后硬刷新 | 页面正常渲染，标签页图标停止转圈 |
| 1 | 识别播放器 | 面板状态行 | "播放中 0:12 / 45:30 · 2x · 0%" |
| 2 | 设置倍速 | 面板倍速下拉 | 视频 `playbackRate` 与选择一致 |
| 3 | 设置音量 | 面板音量滑条 | 视频 `volume` 与滑条一致；0% 时静音 |
| 4 | 自动播放 | 刷新后观察 | 自动开始；被拦截时日志提示"请点击一次页面" |
| 5 | 监听结束 | 快进/等播完 | 日志"视频播放结束"，只出现一次 |
| 6 | 自动下一讲 | 同上 | 1.5s 后点击原生按钮，日志"已切换到下一讲" |
| 7 | 切换后重设参数 | 切到下一讲后看面板 | 倍速/音量保持 |
| 8 | 课程状态 | 面板课程行 | 显示当前讲标题或高亮目录项（启发式，允许为空） |
| 9 | SPA 路由 | 手动点目录切课 | 日志"路由变化"，随后重新识别播放器 |
| 10 | 动态播放器 | 切课后 | 新 `<video>` 被绑定并套用参数 |
| 11 | 异常与日志 | 点击「诊断」 | 控制台输出 JSON；面板显示最近 4 条日志 |
| 12 | 悬浮面板 | 安装后 | 右上角小面板，可拖拽、可折叠 |
| 13 | 暂停自动切换 | 取消勾选"自动下一讲" | 播完不切；日志"自动下一讲已关闭" |
| 14 | 恢复自动切换 | 重新勾选 | 下次播完正常切换 |
| 15 | 停止脚本 | 点「停止」 | 面板变"已停止"，倍速/音量还原，观察器断开；再点「启动」恢复 |

重点回归：

- **不重复绑定**：切课 3 次，日志里"识别到播放器"最多每次一条；无重复点击。
- **不无限切课**：断网或按钮失效时，最多点 2 次，然后 30s 冷却并报错。
- **只触发一次**：单个视频 `ended` 只对应 1 次点击。
- **不干扰站点**：面板折叠后仅剩标题条；点击站点任意区域正常。

---

## 5. 已知限制

1. **跨域 iframe**：如果播放器在 `v.huawei.com` 等不同源 iframe 里，`@match` 不会注入该 frame，
   主文档也无法访问其 DOM。此时面板会显示"未找到视频播放器"。
   → 需要把该域加入 `@match` 单独注入；请把「诊断」输出的 iframe 列表发我，我再加 2.0.1。
2. **Canvas 自绘播放器**：无法读取 `currentTime`，只能通过站点按钮驱动。诊断会报告 canvas 数量。
3. **倍速上限**：部分平台对 >2x 做学时折算或风控；脚本不规避，请按培训规定使用。
4. **课程状态（需求 8）**：站点的目录 DOM 未知，目前用启发式（active/current 类名 + 标题）。
   若显示为空，把目录区域的 HTML 片段发我，可精确适配。
