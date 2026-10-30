# Codex Browser Use

让 Codex 操作你已经登录的 Chrome：读取网页、填写表单、查看视频画面和声音，在操作前定位目标、操作后核对结果，并减少重复输入与提交。

**0.5.0 · Windows + Chrome · 42 个 MCP 工具 · MIT**

Connect Codex to your existing Chrome profile through a local extension and Native Messaging bridge. Keep your browser login sessions, control explicitly selected tabs, and verify actions before continuing.

这是独立实现的开源项目，与 OpenAI、腾讯、WorkBuddy 和其他同类项目无隶属关系。设计参考及来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 主要能力

| 能力 | 当前实现 |
| --- | --- |
| 复用登录状态 | 直接使用安装扩展的 Chrome 配置，Cookie 和网站本地存储由 Chrome 管理；不导出登录凭据 |
| 控制指定标签页 | 列出已有页面、接管用户指定页、创建新页、会话隔离、暂停和释放 |
| 准确定位与输入 | role/name/label/text/placeholder/testId/CSS、稳定 ref、原生点击和键盘、填写与回读 |
| 减少重复动作 | 相同字段值和 URL 自动跳过；任务步骤持久记录，断连恢复先核对结果 |
| 读取复杂页面 | 正文、开放 Shadow DOM、跨域/嵌套 iframe、滚动、截图 |
| 表单与文件 | 复选框、选择框、文件 input、显式下载、JavaScript 弹窗、有限诊断 |
| 视频画面与声音 | 实际播放器识别、播放/跳转、带时间的解码帧、选定播放器音轨，可选本地语音转写 |

完整工具清单见 [FEATURES.md](FEATURES.md)；任务去重与登录证据见 [docs/TASKS.md](docs/TASKS.md)；视频覆盖范围见 [docs/VIDEO.md](docs/VIDEO.md)。

## 安装

需要 Windows、Chrome 116+、Node.js 22+，以及支持 `codex plugin` 的 Codex CLI。先确认 `node --version`、`codex --version` 和 `codex plugin --help` 可用。浏览器控制运行时仅使用 Node.js 标准库，不需要 `npm install` 或额外 API Key。

1. 下载仓库 ZIP 或发布包并解压，也可以克隆仓库。将项目放在准备长期保留的目录中，在含有 `package.json` 的项目根目录打开 PowerShell。
2. 运行安装脚本：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
   ```

   脚本备份相关配置，注册当前 Windows 用户的 Native Messaging host，并通过 Codex CLI 安装本地插件。无需管理员权限。`Bypass` 只作用于这次 PowerShell 进程。仅查看计划可加 `-Plan`。
3. 在 Chrome 打开 `chrome://extensions`，开启“开发者模式”，选择“加载已解压的扩展程序”，选中**本项目的 `extension` 子目录**。安装脚本会输出其绝对路径。不要选择项目根目录或 ZIP 文件。
4. 将 Codex Browser Use 固定到工具栏，打开扩展弹窗，必要时点击“重新连接”。出现“Chrome 已连接”后，在 Codex 开启新聊天；工具目录未刷新时重启 Codex。
5. 试用以下指令：

   > 用 Codex Browser Use 列出我的 Chrome 标签页。

   > 用 Codex Browser Use 打开 https://example.com，读取页面标题和主要内容。

安装后保留源目录：Native Messaging 启动器仍引用这里的代码。移动目录后，需要从新位置重新运行安装脚本，并在 Chrome 重新选择对应的 `extension` 目录。

### 仅接入 MCP 的备用方式

若当前 Codex 不支持本地插件安装，在项目根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -NativeOnly
$browserUseEntry = (Resolve-Path .\src\mcp-server.mjs).Path
codex mcp add browser_use -- node $browserUseEntry
```

之后仍需在 Chrome 加载扩展。这种方式只接入工具；需要时向 Codex 提供本项目 `skills/browser-use/SKILL.md` 的实际路径。不要同时启用备用 MCP 和完整插件，以免出现重复工具。

已有聊天未刷新工具目录时，也可从项目根目录调用同一插件：

```powershell
'{"name":"browser_status","arguments":{}}' | node .\scripts\call.mjs
```

### 更新与卸载

更新时，先结束受控任务，在原安装位置更新项目文件，重新运行安装脚本，再在 `chrome://extensions` 点击本扩展的“重新加载”。也可访问扩展自己的 `chrome-extension://hfkfnchdlckiiehcogghcfkegiikjlii/update.html`；它在磁盘版本变化时重载扩展。重载会结束当前浏览器控制会话，任务恢复见 [docs/TASKS.md](docs/TASKS.md)。

卸载时在项目根目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

然后在 Chrome 移除扩展。源文件和配置备份保留。备用安装使用 `uninstall.ps1 -NativeOnly`，并运行 `codex mcp remove browser_use`。

## 工作方式与数据

```text
Codex → MCP stdio → 本机 127.0.0.1 接口 → Native Messaging → Chrome 扩展 → 指定标签页
```

浏览器操作通过本插件完成。列出未接管页面只返回标签元数据，控制前需要将指定页面加入当前任务会话。不同会话隔离标签归属，仍共享同一个 Chrome 配置中的登录状态。

本机接口使用随机端口和随机凭据，校验 Host 并拒绝带 Origin 的网页请求；凭据不进入工具输出。这不隔离同一 Windows 用户下的恶意本地进程。网页结果会进入当前 Codex 对话，“本机连接”不表示 Codex 不会接收页面内容。

安装写入当前用户注册表 `HKCU\Software\Google\Chrome\NativeMessagingHosts\local.codex.browser_buddy`、`%LOCALAPPDATA%\CodexBrowserBuddy\` 和 Codex 插件配置。旧 host 名称及目录名用于兼容既有安装，不是额外插件。权限用途、持久数据和问题报告方式见 [SECURITY.md](SECURITY.md)。

## 能力边界

- 当前安装器支持 **Windows + Chrome**；macOS/Linux 安装尚未实现。一次连接一个 Chrome 配置，多个配置同时加载时连接最近就绪的那个。重连可用 `expectedProfileId` 核对配置。
- 不操作 `chrome://`、`file://`、浏览器权限窗或系统弹窗。关闭 Shadow DOM、受限 iframe、旋转/3D 变换 iframe 无法保证读取或精确定位。Chrome AX 和文件选择暂限顶层文档；iframe 仍支持 DOM 读取与操作。
- 不提供任意 JavaScript、Cookie 导出或密码读取接口。密码和验证码由用户在原网页流程中完成。发布、发送、支付等操作需要对应任务授权。
- `sent` 只表示输入已发送；`confirmed` 表示结果条件成立；`uncertain` 必须先检查页面，不能盲目重试。暂停不会撤回已经发生的操作。任务检查点不是无人值守调度器。
- 视频采用实际画面采样与音轨采集，不保证逐帧观看或全平台可用。DRM、CORS、后台暂停和网页播放器差异会限制能力；可选 ASR 需要 Python、依赖库及本地模型。评论读取限于页面实际加载的内容。
- 文件选择不等于服务器已接收。下载状态只跟踪插件显式创建的下载；不会自动打开文件。JavaScript 弹窗和诊断需要先启用观察，结束后关闭。

## 开发与验证

在项目根目录执行：

```powershell
npm ci --ignore-scripts
npm run check
npm test
```

这些检查不连接日常 Chrome。GitHub Actions 已配置 Windows/Linux、Node.js 22/24 的静态检查与单元测试；Linux 检查不代表支持 Linux 安装。

在 Git 克隆中，`npm run check:release` 审查暂存文件，`npm run package` 从干净的当前提交生成 ZIP、SHA-256 和文件清单，输出到 `output/release/`。下载的 ZIP 不含 Git 历史，需要克隆仓库或初始化本地 Git 才能重新打包。

隔离浏览器测试、真实 Chrome 联调及其依赖见 [CONTRIBUTING.md](CONTRIBUTING.md)。真实浏览器测试必须手动执行，不在 CI 中连接个人浏览器。发布步骤见 [docs/RELEASING.md](docs/RELEASING.md)。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 本机接口未连接 | 确认源目录和 Node.js 仍可用；重跑安装脚本，再点“重新连接” |
| Chrome 已连接但 Codex 无工具 | 检查 `codex plugin list`，重启 Codex 并开新聊天 |
| Tab is not shared | 先 `browser_user_tabs` 找到指定页，再用本任务 sessionId 调用 `browser_claim` |
| ref 过期、目标被遮挡或匹配多项 | 重新 snapshot/find，检查实际页面并细化定位 |
| debugger attach 失败 | 关闭该页 DevTools 或其他调试器连接 |
| unknown 登录状态 | 缺少可靠页面证据；先查看账号导航控件，不把内容作者头像当当前账号 |

固定扩展 ID 为 `hfkfnchdlckiiehcogghcfkegiikjlii`。manifest 内的 `key` 是保持此 ID 的**公钥**，不是 API Key；不要在普通更新中重新生成它。

## 许可证与参考

[MIT License](LICENSE) · [设计来源](THIRD_PARTY_NOTICES.md) · [更新记录](CHANGELOG.md)

打包形式参考 [OpenAI 插件文档](https://developers.openai.com/plugins/build/plugins) 和 [本地 MCP 配置](https://developers.openai.com/plugins/deploy/desktop-only#configure-a-local-mcp-server)。
