# 发布到 GitHub

仓库建议命名为 `codex-browser-use`。公开性、仓库所属账号以及是否上传，应由发布者在实际创建仓库前明确选择。本地准备不自动创建远程仓库、标签或 GitHub Release。

## 首次提交

在项目根目录初始化 Git，使用自己的 Git 作者身份：

```powershell
git init -b main
git add .
npm ci --ignore-scripts
npm run check
npm test
npm run check:release
git diff --cached --stat
git diff --cached --check
git commit -m "Prepare Codex Browser Use 0.5.0 for GitHub"
npm run package
```

已有仓库跳过初始化。`check:release` 扫描**暂存对象**，不是 Git 目录外的所有文件；修改后重新 `git add` 再执行。它采用发布路径白名单，并阻止常见凭据、本机路径、符号链接和子模块进入发布树。不要用强制添加绕过运行目录的忽略规则。

`package` 要求没有未提交或未忽略的文件，从 `HEAD` 的 Git 对象打包，因此不会顺手包含 `output/`、配置备份或浏览器数据。它同时校验提交内容，产生：

- `output/release/codex-browser-use-<version>.zip`：完整项目，包含隐藏插件清单、源码、安装脚本、文档和测试。
- 同名 `.zip.sha256`：ZIP 的 SHA-256。
- 同名 `.manifest.json`：提交 ID、版本、每个文件的大小及 SHA-256。

ZIP 内使用 `codex-browser-use/` 顶层目录。文件清单的哈希对应 Git 保存的字节；工作区的换行转换可能不同。开发检查依赖 Git，安装和运行发布包不需要 Git。

## 创建并推送仓库

先核对登录账号和可见性，再在 GitHub 创建**空仓库**，不要自动生成 README 或许可证。复制该仓库提供的 HTTPS/SSH 地址，在本地执行：

```powershell
git remote add origin <YOUR_REPOSITORY_URL>
git remote -v
git push -u origin main
```

`<YOUR_REPOSITORY_URL>` 是需要替换的占位符。不要把访问 Token 写进 URL、文件或命令历史。如果已有 origin，先核对目标，避免覆盖其他仓库配置。Git 提交会公开其作者姓名和邮箱；需要隐私时，在提交前采用 GitHub 提供的 noreply 邮箱。

建议仓库描述：`Control your existing Chrome from Codex with verified actions, task checkpoints and video evidence.`

建议 topics：`codex`、`mcp`、`chrome-extension`、`browser-automation`、`native-messaging`。

推送后查看 Actions 检查结果；CI 在 Windows/Linux 和 Node.js 22/24 上执行本地检查及单元测试，只上传打包产物作为 Actions artifact，不自动创建 Release。首次公开前建议启用 GitHub 的私密漏洞报告。

## 版本发布

同步 `package.json`、`package-lock.json`、`plugin.json`、`.codex-plugin/plugin.json`、`extension/manifest.json` 和 `extension/version.js` 的版本，并更新 CHANGELOG。保持扩展公钥与 ID 稳定。

完成相关测试后，在确认要发布的提交上创建版本 tag。初次发布的说明草稿见 [releases/0.5.0.md](releases/0.5.0.md)。创建 GitHub Release 时附上 ZIP、SHA-256 和 manifest；发布动作需单独执行，本项目没有自动公开发布脚本。

`output/` 下的真实 Chrome 报告、媒体证据和本机验收记录不附加到 Release。展示功能时应另用无登录信息的演示页面制作素材。
