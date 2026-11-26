# 发布与维护指南

本文件说明如何把项目发布到 GitHub，以及后续如何发新版本。

---

## 1. 创建仓库

建议仓库名：`huawei-talent-auto`（与脚本文件名一致，方便记忆）。

GitHub → New repository → 不要勾选任何初始化文件 → Create。

## 2. 首次推送

在项目目录 `C:\Users\HAOHAO\Desktop\HuaweiTalentAuto` 下执行：

```bash
git init
git add .
git commit -m "feat: Huawei Talent Auto Player v2.0.3"
git branch -M main
git remote add origin https://github.com/<your-username>/huawei-talent-auto.git
git push -u origin main
```

## 3. 替换 README 里的占位链接

把 `README.md`、`README.en.md` 中的

```
<your-username>/<repo>
```

替换成你的真实用户名和仓库名，例如：

```
https://raw.githubusercontent.com/zhangsan/huawei-talent-auto/main/huawei-talent-auto.user.js
```

国内网络可用 jsDelivr 备用地址：

```
https://cdn.jsdelivr.net/gh/zhangsan/huawei-talent-auto@main/huawei-talent-auto.user.js
```

## 4. （可选）让 Tampermonkey 自动检查更新

在脚本头部追加两行（URL 换成你的真实地址）：

```js
// @updateURL    https://raw.githubusercontent.com/<user>/<repo>/main/huawei-talent-auto.user.js
// @downloadURL  https://raw.githubusercontent.com/<user>/<repo>/main/huawei-talent-auto.user.js
```

> 若用户是通过 raw 链接点击安装的，Tampermonkey 默认就会以该地址检查更新，
> 这两行不是必需的。

## 5. 发布新版本的流程

1. 修改 `huawei-talent-auto.user.js` 头部的 `@version`
2. 在 `CHANGELOG.md` 顶部增加 `## [x.y.z] - YYYY-MM-DD`
3. 提交并打标签：

```bash
git add .
git commit -m "fix: 修复 xxx"
git tag v2.0.4
git push
git push --tags
```

4. GitHub → Releases → Draft a new release → 选择标签 `v2.0.4`
   → 标题 `v2.0.4` → 正文粘贴 CHANGELOG 对应段落
   → 把 `huawei-talent-auto.user.js` 作为附件上传（可选，方便下载）
5. Publish release

## 6. 版本号约定

| 变更类型 | 版本位 | 示例 |
|---|---|---|
| 破坏性变更 / 重写 | major | 1.x → 2.0.0 |
| 新功能 | minor | 2.0.3 → 2.1.0 |
| 修复 | patch | 2.0.2 → 2.0.3 |

## 7. 仓库设置建议

- **Description**：`Tampermonkey userscript: auto speed/mute/next-lesson for Huawei Talent courses`
- **Topics**：`tampermonkey` `userscript` `javascript` `huawei` `video`
- **Issues**：开启，并保留 `.github/ISSUE_TEMPLATE/bug_report.md`
- **License**：选择 MIT（仓库会自动识别 `LICENSE` 文件）

## 8. 截图注意事项

截图请**裁剪或打码**以下信息后再放入 `screenshots/`：

- 右上角账号名、头像等信息
- 其他登录态信息、课程姓名、团队名称

推荐只截取「视频区域 + 右侧面板」这一块。
