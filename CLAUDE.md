# 项目说明（给 Claude Code / 维护者）

华为人才在线课程播放辅助 · Tampermonkey 用户脚本。

- 仓库：<https://github.com/efoolbug/huawei-talent-auto>
- 当前版本：以 `huawei-talent-auto.user.js` 头部 `@version` 为准（2.2.0）
- 单文件交付：Tampermonkey 不支持本地多文件 `require`，所有逻辑都在一个 `.user.js` 里

## 关键结构（改代码前必读）

课程页是「主文档 + 跨域 iframe」：

```
e.huawei.com/cn/talent/outPage/        主文档：面板、设置、日志、兜底点击
talent.shixizhi.huawei.com/course/…    iframe：真正的 <video> 与原生「上一讲/下一讲」
```

脚本在两个 frame 各跑一份（两个 `@match`）。主框架通过 `postMessage` 下发
`cfg / next / stop / start / rescan`，子框架上报 `state / ended / needNext / log`。

## 三条设计红线

1. **MutationObserver 回调里绝不写 DOM**。1.0.0 就是因为在回调里改写面板文本，
   形成微任务级无限循环，导致整页空白。回调只置 debounce 标记，扫描函数只读。
2. **面板必须放在 Shadow DOM**，这样面板内部的文字更新不会产生文档 mutation。
3. **不改任何原生原型**，只在具体 `<video>` 实例上设置 `playbackRate / volume / muted`。

## 其他既有约束

- 下一讲：一次性锁 `nextState` + 导航变化确认 + 最多重试 1 次 + 失败后 30s 冷却。
- `ended` 需通过三道校验：是主播放器、时长 ≥ 30s、不是刚开播 5 秒内触发。
- 「下一讲」按钮只认**自身文本整段就是「下一讲」**的元素，不能点包住两个按钮的外层容器。
- 无视频小节跳过：默认关闭，停留 10s 判定；命中测验关键词（提交答案/交卷/答题卡…）时拒绝跳过。
- 多 Part 小节（2.2.0）：一个章节可能在**同一页面里垂直堆叠多个 video.js 播放器**
  （`Part 01…Part 0N`），底部「上一讲 / 下一讲」是**章节级**按钮。只能跟踪
  「当前正在播的那一个」视频；本小节所有 Part 播完才允许点「下一讲」，
  绝不能越过未播的 Part 跳到下一章。
- 配置存 Tampermonkey 本地存储键 `htap.cfg`。

## 验证方式

1. 打开课程页，看面板状态与 `[HTAP]` / `[子]` 日志；
2. 重点回归：
   - 视频自然播完 → 只切一次下一讲；
   - 切讲后新视频自动播放且倍速/音量保持；
   - 假 `ended`（刚开播就结束）被拦截；
   - 连续切 3 讲不重复、不死循环；
   - 图文小节（如「本章导读」）开启开关后 10s 自动跳过；
   - 多 Part 小节（如 8.1 的 Part 01~06）逐个播完、目录打勾后才进入下一章；
   - 单视频小节行为与 2.1.x 一致。
3. 无法识别播放器时，用面板「诊断」导出 video/iframe/canvas 信息。

## 发版流程

1. 修改 `huawei-talent-auto.user.js` 头部 `@version`
2. 在 `CHANGELOG.md` 顶部新增一条
3. `git add . && git commit && git push`
4. `git tag vX.Y.Z && git push --tags`，再到 GitHub 建 Release（详见 `PUBLISHING.md`）

## 合规边界

只做倍速/音量/播放/按站内原生按钮切下一讲；**不**伪造观看时长、完成状态，
**不**绕过考核、人脸或防挂机机制。平台在后台标签页暂停播放属于其自身策略，不要绕过。
