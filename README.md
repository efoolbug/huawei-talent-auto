# Huawei Talent Auto Player

> 华为人才在线（`e.huawei.com/cn/talent`）课程播放辅助 · Tampermonkey 用户脚本
> 自动倍速、静音、自动播放、播完自动切「下一讲」，带可拖拽悬浮面板。

![version](https://img.shields.io/badge/version-2.2.0-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/platform-Chrome%20%2B%20Tampermonkey-lightgrey)
![javascript](https://img.shields.io/badge/language-Vanilla%20JS-yellow)

[English](README.en.md) · [更新日志](CHANGELOG.md) · [验收记录](docs/03-acceptance.md)

---

## 特性

| 功能 | 说明 |
|---|---|
| 自动识别播放器 | 支持播放器位于**跨域 iframe**（`talent.shixizhi.huawei.com`）的情况 |
| 自动倍速 | 0.5x ~ 3x，设置后持久化 |
| 自动音量 | 0%~100%；0% 时自动静音以配合浏览器自动播放策略 |
| 自动播放 | 遵守 Chrome 自动播放策略，被拦截时给出明确提示 |
| 自动下一讲 | 监听真实 `ended`，点击站内原生「下一讲」按钮 |
| 多 Part 小节连播 | 一个章节里堆叠了 Part 01…Part 06 多个播放器时，先把本小节所有 Part 播完，再切下一章（2~N 个自适应） |
| 跳过图文小节 | 无 `<video>` 的图文/课件页停留 10s 后自动下一讲（可开关；测验页不跳过） |
| 切课保持参数 | 新视频加载后自动重新套用倍速/音量 |
| SPA 适配 | `hashchange` + 路由轮询 + DOM 观察三路触发 |
| 动态播放器 | 播放器被销毁/重建后自动重新绑定 |
| 悬浮面板 | 可拖拽、可折叠，Shadow DOM 隔离，不干扰站点样式 |
| 暂停 / 恢复 / 停止 | 自动切课可随时暂停；「停止」会还原原始倍速与音量 |
| 日志与诊断 | 子框架日志回传主面板；一键复制诊断 JSON |

---

## 安装

### 1. 前置条件

- Chrome / Edge / Brave 等 Chromium 内核浏览器
- [Tampermonkey](https://www.tampermonkey.net/) 扩展

### 2. 安装脚本

**方式 A：点击链接安装**

```
https://raw.githubusercontent.com/efoolbug/huawei-talent-auto/main/huawei-talent-auto.user.js
```

> 国内网络访问 `raw.githubusercontent.com` 不稳定时，可用 jsDelivr：
> `https://cdn.jsdelivr.net/gh/efoolbug/huawei-talent-auto@main/huawei-talent-auto.user.js`

**方式 B：手动安装**

1. Tampermonkey → 管理面板 → `+` 新建脚本
2. 删除模板内容，粘贴 [`huawei-talent-auto.user.js`](huawei-talent-auto.user.js) 全文
3. `Ctrl + S` 保存

### 3. 使用

打开课程页 `https://e.huawei.com/cn/talent/outPage/#/sxz-course/home`，右上角出现「华为课程助手」面板即生效。

---

## 面板说明

| 控件 | 作用 |
|---|---|
| 倍速 | 0.5x ~ 3x，写入后自动保存 |
| 音量 | 0% 时自动静音 |
| 自动下一讲 | 取消勾选 = 暂停自动切换；重新勾选 = 恢复 |
| 无视频小节自动跳过 | 图文/课件页停留 10s 后自动下一讲；测验/答题页会拒绝跳过 |
| 下一讲 | 手动触发一次（与自动切课共用同一套锁与确认逻辑） |
| 重新扫描 | 强制重新查找播放器 |
| 诊断 | 输出 video / iframe / canvas 信息，并复制完整 JSON |
| 停止 / 启动 | 停止时断开观察器、清理定时器、还原原始播放参数 |
| 标题栏 | 按住拖动；右侧 `−` 折叠 |

---

## 工作原理

目标页面由**主文档**和**跨域 iframe** 两层组成，所以脚本按 frame 分工：

```
主文档 (e.huawei.com)                 iframe (talent.shixizhi.huawei.com)
├── 浮层面板 / 设置 / 日志        ←──  postMessage  ──┤  自动播放 / 倍速 / 音量
├── 汇总子框架状态                ──→  cmd(next/stop) ─→│  查找并点击原生「下一讲」
└── 兜底：也尝试点击主文档内的按钮                      └── ended 事件上报
```

三条设计约束（也是 1.0.0 白屏事故的教训）：

1. **观察器回调绝不写 DOM**：回调只置 debounce 标记，扫描函数只读；
2. **面板放在 Shadow DOM**：面板内部的文字更新不会产生文档 mutation；
3. **不改任何原生原型**：只在具体 `<video>` 实例上设置 `playbackRate` / `volume` / `muted`。

下一讲采用 **一次性锁 + 导航变化确认 + 最多重试 1 次 + 30s 冷却**，杜绝无限切课。

多 Part 小节（如 8.1 BGP路径属性 里的 Part 01~06）是**同一页面里的多个 video.js 播放器**，
底部「上一讲 / 下一讲」是**章节级**按钮。脚本只跟踪"当前正在播的那一个"视频，
当前 Part 播完后按页面上的 `Part 0X` 标题找到下一部分并激活播放；站点自己会接续时
则让站点接、脚本不抢。**本小节全部 Part 播完才会点「下一讲」**，因此不会再出现
「8.1 只播了前两个 Part 就跑到 8.2」的情况。

---

## 常见问题

<details>
<summary><b>页面空白 / 一直转圈</b></summary>

这是 **1.0.0** 的已知 bug：`MutationObserver` 回调里改写了位于被观察子树内的面板文本，
形成微任务级无限循环，占满主线程。**升级到最新版即可**，根因分析见
[`docs/02-audit-v1.0.0.md`](docs/02-audit-v1.0.0.md)。
</details>

<details>
<summary><b>面板显示「未找到视频播放器」</b></summary>

两种正常情况：

1. 该小节是**图文/课件**，本来就没有 `<video>`；
2. 播放器位于其它**未授权**的跨域 iframe 中。

点「诊断」查看 `videos` / `iframes`，如果是新的 iframe 域名，在脚本头部追加一行
`// @match https://新的域名/*` 即可。
</details>

<details>
<summary><b>刷新后没有自动播放，要手动点一次</b></summary>

Chrome 对跨域 iframe 的自动播放有策略限制。脚本会在面板提示
「浏览器阻止播放：请在视频画面上点一次」，点击一次后即可正常。
</details>

<details>
<summary><b>点「下一讲」没反应</b></summary>

看面板日志最后一行：

- `未找到「下一讲」按钮` → 可能是最后一讲，或按钮结构变了（把日志发到 Issues）
- `「下一讲」按钮当前不可点击` → 站点在未看完时禁用了按钮
- `点击后 15s 内未检测到课程切换` → 按钮点到了但站点没响应
</details>

<details>
<summary><b>平台会记录我的学习进度吗？</b></summary>

会。脚本播放的是**真实的视频**，只是倍速与静音，不伪造时长、不跳过内容。
实测（2026-11-26）2x 播放平台照常计入进度，见 [`docs/03-acceptance.md`](docs/03-acceptance.md)。
平台策略如有调整，属于站点行为。
</details>

---

## 已知限制

- 硬刷新后视频从头播放（站点自身不记忆播放位置，脚本未干预）；
- 纯图文小节没有播放器，面板会显示「未找到播放器」；
- 若平台未来更换播放器实现（Canvas / 更深的 iframe 嵌套），需要相应调整 `@match` 或识别逻辑。

---

## 隐私

- 不收集、不上传任何数据；
- 不使用任何远程接口；
- 配置仅保存在 Tampermonkey 本地存储（`htap.cfg`），诊断信息只在本地控制台输出。

---

## 免责声明

本项目为**个人学习/研究用途**的浏览器自动化示例，与华为公司及任何培训平台无关联，
未获其授权或认可。

- 请遵守所在平台的服务条款与培训管理规定；
- 使用本脚本产生的一切后果（含学时认定、账号风控等）由使用者自行承担；
- 本项目**不提供**伪造学习时长、伪造完成状态、绕过考核或人脸识别等能力。

---

## 目录结构

```
huawei-talent-auto/
├── huawei-talent-auto.user.js   主脚本（单文件，可直接安装）
├── README.md / README.en.md
├── CHANGELOG.md
├── PUBLISHING.md                发布与维护步骤
├── LICENSE
├── docs/
│   ├── 01-troubleshooting.md    排查方法与诊断工具说明
│   ├── 02-audit-v1.0.0.md       1.0.0 白屏根因与修复映射
│   └── 03-acceptance.md         实机验收记录
├── tools/
│   ├── diagnose.console.js      只读诊断快照（Console 粘贴）
│   └── probe.user.js            加载时间线探针
└── screenshots/                 截图（自行添加，勿含个人信息）
```

---

## 贡献

欢迎提 Issue / PR。提交前请确认：

1. 修改后脚本仍满足「观察器回调不写 DOM」；
2. 不引入远程依赖、不修改原生原型；
3. 变更记录写入 `CHANGELOG.md` 并递增 `@version`。

---

## 许可

[MIT](LICENSE)
