# Codex Browser Use

让 Codex 操作你已经登录的 Chrome：读取网页、填写表单、查看视频画面和声音，在操作前定位目标、操作后核对结果，并减少重复输入与提交。

**0.5.1 · Windows + Chrome · 42 个 MCP 工具 · MIT**

Connect Codex to your existing Chrome profile through a local extension and Native Messaging bridge. Keep your browser login sessions, control explicitly selected tabs, and verify actions before continuing.

> **作者服务：[jarlessapi](https://jarlessapi.com)** — 项目作者运营的 API 中转站。欢迎按需了解并支持持续开发；本插件的浏览器控制功能无需注册或购买该服务。

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

第一次使用可依次阅读：[准备环境](#1-准备环境) → [下载项目](#2-下载项目) → [安装并连接](#3-安装并连接) → [确认安装成功](#4-确认安装成功) → [日常使用](#日常使用)。

也可以直接复制下面的 [Agent 安装示例](#让-agent-帮你安装)，让 Agent 完成环境检查、安装和连接验收。

## 安装

需要同时安装 **Chrome 扩展**和 **Codex 插件/本机连接程序**。安装脚本负责后者，Chrome 扩展需要在 Chrome 中手动加载一次。

### 让 Agent 帮你安装

将下面整段发给能访问这台电脑文件和 PowerShell 的 **Codex、Claude Code 或其他 Agent**，先替换安装目录。这份示例的安装目标是 **Codex**；负责安装的 Agent 不一定是 Codex。只有网页聊天能力、无法执行本机命令的 Agent 只能提供指导。

```text
请帮我在这台 Windows 电脑上安装并验证 Codex Browser Use，让 Codex 能操作我平时已经登录的 Chrome。

仓库：https://github.com/niu1147713149-png/codex-browser-use
安装目录：<替换为准备长期保留的绝对路径>

请直接执行安装，并按以下步骤核验：
1. 检查安装目录。已有本项目时沿用它并保留本地修改；否则把仓库克隆到这个目录，也可以使用我提供的已解压源码。仓库无法访问时，先核对网址和网络，再尝试我提供的本地源码路径，不要求我在聊天里粘贴 Token。
2. 阅读项目 README.md 和 scripts/install.ps1，核对 Windows、Chrome 125+、Node.js 22+、Codex CLI 和 codex plugin 支持情况。缺少依赖时按 README 的官方来源补齐；遇到需要本人登录或系统确认的步骤时告诉我。
3. 在含有 package.json 的项目根目录先执行安装预览：
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Plan
   预览无误后执行安装：
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
   检查退出结果，保留安装脚本生成的配置备份。如果当前 Codex 不支持插件安装，按 README 的 MCP 备用方式接入，避免重复启用两套工具。
4. 输出 extension 子目录的完整绝对路径，指导我在平时已登录的 Chrome 中打开 chrome://extensions，开启开发者模式，加载该目录，再打开扩展弹窗点击“重新连接”。这一步由我手动完成；沿用现有 Chrome 个人资料。
5. 我回复完成后，检查 Codex 插件安装状态和 browser_status；正常连接应为 connected: true、paused: false。当前聊天未加载工具时，可在项目根目录通过同一插件检查连接：
   '{"name":"browser_status","arguments":{}}' | node .\scripts\call.mjs
6. 指导我在 Codex 新聊天中用本插件列出真实 Chrome 标签页，再打开 https://example.com 并读取标题和正文。若你就是已加载插件的 Codex，直接完成这两项验收；需要重启 Codex 或切换聊天时，明确哪些验收仍待完成。
7. 最后报告安装目录、扩展目录、安装方式、版本、验证结果和剩余手动步骤。只有脚本成功或本机通道连通时，不要把它当作 Codex 中的完整验收已通过。
```

在 Chrome 加载扩展后，可回到原 Agent 对话发送：

```text
我已在平时使用的 Chrome 中加载你给出的 extension 目录，弹窗显示“Chrome 已连接”。请从连接检查继续，核对安装结果，并完成你能执行的验收；需要我在 Codex 新聊天验证的部分，请给出具体指令。
```

公开仓库支持直接下载 ZIP 或克隆，安装本项目无需提供 GitHub Token。使用私有 fork 时，命令行 Git 另需该仓库的访问权限，也可以从已下载的源码开始安装。具体手动操作和验收标准见下文。

### 1. 准备环境

| 项目 | 要求及准备方式 |
| --- | --- |
| 系统 | Windows；当前安装脚本不支持 macOS/Linux |
| 浏览器 | [Chrome](https://www.google.com/chrome/) 125+；在你平时使用、已登录网站账号的 Chrome 个人资料中安装扩展 |
| Node.js | [Node.js](https://nodejs.org/en/download) 22+，已加入 `PATH`；CI 验证 Node.js 22 和 24 |
| Codex | 已能正常使用 Codex，并安装支持 `codex plugin` 的 [Codex CLI](https://developers.openai.com/codex/cli/)；桌面端用户也需要 CLI 来运行本项目安装脚本 |
| Git | 仅克隆或用 Git 更新项目时需要；下载 ZIP 不需要 Git |

安装 Node.js 后重新打开 PowerShell。尚未安装 Codex CLI 时执行：

```powershell
npm.cmd install -g @openai/codex
```

已有 CLI 但缺少 `plugin` 子命令时，也可用上述命令更新；仍不支持时使用下方的 [MCP 备用方式](#仅接入-mcp-的备用方式)。在 PowerShell 检查：

```powershell
node --version
codex --version
codex plugin --help
```

应能看到 Node.js 22 或更高版本、Codex 版本，以及包含 `add`、`list`、`marketplace` 的插件帮助。若提示命令不存在，先完成安装并重新打开终端。

Chrome 125+ 提供 iframe 原生输入所需的子目标调试接口。浏览器控制运行时仅使用 Node.js 标准库，项目本身不需要 `npm install` 或额外 API Key；使用 Codex 本身所需的账号和网络连接仍按 Codex 的要求准备。

### 2. 下载项目

两种方式任选其一：

- **下载 ZIP**：打开 [GitHub 仓库](https://github.com/niu1147713149-png/codex-browser-use)，点击 **Code → Download ZIP**，完整解压。
- **Git 克隆**：在准备长期存放项目的父目录打开 PowerShell，执行：

  ```powershell
  git clone https://github.com/niu1147713149-png/codex-browser-use.git
  cd codex-browser-use
  ```

ZIP 解压后的目录通常叫 `codex-browser-use-main`，克隆目录通常叫 `codex-browser-use`，均可安装。找到同时包含 `package.json`、`scripts`、`extension` 的那一层，在该目录打开 PowerShell。后续命令均在这里执行：

```powershell
Test-Path .\package.json
Test-Path .\scripts\install.ps1
Test-Path .\extension\manifest.json
```

三项都应返回 `True`。安装后需要保留这个目录，不要只保留 `extension` 子目录。

### 3. 安装并连接

1. 在项目根目录运行：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
   ```

   脚本备份相关配置，注册当前 Windows 用户的 Native Messaging host，并通过 Codex CLI 安装本地插件。无需管理员权限。`Bypass` 只作用于这次 PowerShell 进程。仅查看计划可加 `-Plan`。
2. 在你平时已登录网站的 Chrome 个人资料中，将 `chrome://extensions` 粘贴到地址栏并打开。开启右上角“开发者模式”，选择“加载已解压的扩展程序”，选中**本项目的 `extension` 子目录**。安装脚本会输出其绝对路径。不要选择项目根目录或 ZIP 文件。
3. 点击 Chrome 工具栏的拼图按钮，将 **Codex Browser Use** 固定。打开扩展弹窗，必要时点击右上角的 **↻ 重新连接**。应出现“Chrome 已连接”，详情显示“本机通道已就绪，等待 Codex 调用”。
4. 在 Codex 开启新聊天；工具目录未刷新时重启 Codex。刚安装时弹窗中的“活跃会话”为 `0` 是正常现象，要开始操作页面才会创建会话。

安装后保留源目录：Native Messaging 启动器仍引用这里的代码。移动目录后，需要从新位置重新运行安装脚本，并在 Chrome 重新选择对应的 `extension` 目录。

### 4. 确认安装成功

在新 Codex 聊天中依次发送：

> 用 Codex Browser Use 列出我的 Chrome 标签页。

> 用 Codex Browser Use 打开 https://example.com，读取页面标题和主要内容。

第一条应返回当前 Chrome 的真实标签页标题和 URL；第二条应在同一 Chrome 配置中新建页面，并读出 **Example Domain**。第二条还依赖你的网络能访问该网站。能列出标签页，但网站打不开时，应检查该网站连接。

只列出标签页不会创建控制会话；开始操作后，可在扩展弹窗中查看会话和受控页面。任务结束时 Codex 可能已经释放它们。

如果 Codex 没有发现工具，在 PowerShell 中辅助检查：

```powershell
codex plugin list --marketplace browser-use-local
'{"name":"browser_status","arguments":{}}' | node .\scripts\call.mjs
```

第一条应能找到已安装的 `codex-browser-use`。第二条通过同一个插件检查本机连接，正常结果应包含 `connected: true`、`paused: false`，以及与扩展弹窗一致的 `version`。它成功说明源码中的 MCP 到 Chrome 通道可用；仍需在 Codex 聊天完成上面的验收，才能确认 Codex 已加载插件。

### 仅接入 MCP 的备用方式

若当前 Codex 不支持本地插件安装，在项目根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -NativeOnly
$browserUseEntry = (Resolve-Path .\src\mcp-server.mjs).Path
codex mcp add browser_use -- node $browserUseEntry
```

之后仍需在 Chrome 加载扩展。这种方式只接入工具；需要时向 Codex 提供本项目 `skills/browser-use/SKILL.md` 的实际路径。不要同时启用备用 MCP 和完整插件，以免出现重复工具。

备用方式使用 `codex mcp list` 检查 `browser_use`，再完成相同的聊天验收；不要求它出现在 `codex plugin list` 中。若完整插件已装上一部分，先在 Codex 插件页面停用或移除该插件，再使用备用方式。

## 日常使用

### 使用已经登录的页面

在装有扩展的 Chrome 中正常登录目标网站，然后在 Codex 中说明**网站或页面名称、要做的事、完成标准**。例如：

> 用 Codex Browser Use 操作我已打开的 YouTube 页面，搜索“AI 编程”，整理最近一周能找到的 5 个视频，给出标题、频道、发布日期、播放量和链接；页面没有显示的数据标注“未显示”。

Codex 会先列出标签页、创建本次任务会话，再接管你指定的页面。通常不需要你再点击共享，也不需要手动填写 `sessionId`、`tabId` 或导出 Cookie。插件复用的是这个 Chrome 个人资料已有的登录状态；不同个人资料、访客和无痕窗口的登录环境不能混用。

若想自己选定页面：先对 Codex 说“为这次操作创建一个浏览器会话，名称是网页整理”，然后切到目标标签页，打开扩展弹窗，在下拉框选中“网页整理”，点击“共享当前标签页”。同一页面同时只能归属一个控制会话。

### 可直接复制的任务示例

| 任务 | 发给 Codex 的指令 |
| --- | --- |
| 只查看标签栏 | 用 Codex Browser Use 按窗口和标签栏顺序列出所有已打开页面的标题和链接。 |
| 搜索 X | 用 Codex Browser Use 在 X 搜索“AI 信息差”，整理最近 7 天能找到的相关推文，保留原帖链接和页面显示的日期。 |
| 阅读文章 | 用 Codex Browser Use 读取我已打开的这篇文章，归纳核心观点，引用原文中支持每个观点的段落。 |
| 填写表单 | 用 Codex Browser Use 在我指定的表单中填写以下资料：姓名＝张三，备注＝预约产品演示。回读字段核对，填好后停在提交前。 |
| 分析视频 | 用 Codex Browser Use 查看我当前打开的 YouTube／抖音作品，先核对标题和作者，再分析前 60 秒的实际画面与声音，按时间点整理内容，说明画面采样间隔及声音缺口。 |
| 查看评论 | 用 Codex Browser Use 读取该视频页面实际加载的前 30 条评论及可见点赞数，注明是否包含回复；未加载或未显示的数据单独说明。 |

把示例中的网站、关键词、时间范围和资料替换成你的任务即可。视频采集需要实际播放相应时长；声音理解取决于当前模型是否能处理采集音频，或是否已安装本地转写依赖与模型。它不会因为收集了画面就自动宣称看完视频，详见 [视频读取说明](docs/VIDEO.md)。

### 暂停、结束与中断恢复

| 扩展弹窗操作 | 实际效果 |
| --- | --- |
| 暂停控制 / 恢复控制 | 暂停或恢复此配置中所有会话的控制；已发生的网页动作不会撤销 |
| 页面旁的“释放” | 解除该标签页的控制，页面保持打开 |
| 会话旁的“结束” | 结束该会话并释放其全部标签页，页面保持打开 |

也可直接告诉 Codex：“结束本次浏览器会话，保留页面。”如需关闭任务创建的标签页，可明确要求：“清理本次任务新建的页面，保留我原先打开的页面。”

重要的多步填写或提交，可以在任务中补充：“使用任务检查点，记录步骤和结果；遇到超时先检查页面，再决定下一步。”断连后，在**原 Codex 聊天**中说：“恢复刚才的浏览器任务，先核对 Chrome 配置、页面账号和已完成步骤。”恢复依赖该聊天保留的任务 ID 与结果条件；普通直接调用不具备完整的持久去重，也不会在你离开后自动执行任务。细节见 [docs/TASKS.md](docs/TASKS.md)。

## 更新与卸载

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
- 不操作 `chrome://`、`file://`、浏览器权限窗或系统弹窗。关闭 Shadow DOM、受限 iframe、旋转/3D 变换 iframe 无法保证读取或精确定位。Chrome AX 和文件选择暂限顶层文档；iframe 支持 DOM 读取，以及绑定 Chrome 子目标的原生鼠标操作。同一输入目标内仅转换同源 frame 坐标；跨域 frame 缺少独立输入目标时返回 `FRAME_ROUTING_UNAVAILABLE`，不回退到父页面坐标点击。
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
| 找不到 `node` 或 `codex` | 安装对应程序后重新打开 PowerShell；运行“准备环境”中的版本检查。使用桌面端也需安装 CLI |
| PowerShell 提示禁止运行 `codex.ps1` | 对直接调用 CLI 的命令使用 `codex.cmd`，例如 `codex.cmd --version`；安装脚本仍用本文的 `powershell.exe ... -ExecutionPolicy Bypass` 命令 |
| 找不到脚本或扩展 `manifest.json` | 确认 ZIP 已完整解压；PowerShell 工作目录应包含 `package.json`，Chrome 加载的应是其下的 `extension` 文件夹 |
| 不识别 `codex plugin` | 更新 Codex CLI；仍不支持则按“仅接入 MCP 的备用方式”安装 |
| 本机接口未连接 | 确认源目录和 Node.js 仍可用；重跑安装脚本，再点“重新连接” |
| `Specified native messaging host not found` | 在运行 Chrome 的同一 Windows 用户下重新运行安装脚本，核对加载的是本项目扩展，再点“重新连接” |
| Chrome 已连接但 Codex 无工具 | 检查 `codex plugin list`，重启 Codex 并开新聊天 |
| “共享当前标签页”按钮灰色 | 先让 Codex 创建浏览器会话；确认已连接且没有暂停，刷新弹窗后选择会话 |
| `Codex Browser Use 已暂停` / 控制已暂停 | 在扩展弹窗点击“恢复控制”，然后检查任务状态再继续 |
| 标签列表或网站登录账号不对 | 核对当前 Chrome 个人资料；一次只连接要操作的配置。出现 `PROFILE_MISMATCH` 时返回原配置，再恢复任务 |
| Tab is not shared | 先 `browser_user_tabs` 找到指定页，再用本任务 sessionId 调用 `browser_claim` |
| ref 过期、目标被遮挡或匹配多项 | 重新 snapshot/find，检查实际页面并细化定位 |
| debugger attach 失败 | 关闭该页 DevTools 或其他调试器连接 |
| unknown 登录状态 | 缺少可靠页面证据；先查看账号导航控件，不把内容作者头像当当前账号 |

报告问题时提供 Windows、Chrome、Node.js、Codex 和扩展版本，失败发生在哪一步，以及具体报错文字。相关日志和截图只保留必要部分，不附 Cookie、Token、`connection.json` 或未脱敏的个人页面。

固定扩展 ID 为 `hfkfnchdlckiiehcogghcfkegiikjlii`。manifest 内的 `key` 是保持此 ID 的**公钥**，不是 API Key；不要在普通更新中重新生成它。

## 支持项目与作者服务

如果这个项目帮到了你，欢迎 Star、反馈使用体验或提交改进。你也可以了解作者运营的 API 中转站 **[jarlessapi](https://jarlessapi.com)**，按自己的需要选择服务，支持项目持续开发。

本仓库的 **Sponsor** 按钮链接到 [jarlessapi.com](https://jarlessapi.com)，用于展示作者服务。支持完全自愿；项目按 MIT 许可证开放，浏览器控制功能无需注册或充值 jarlessapi。安装脚本不会配置中转站或更换你的模型 API 地址。

## 鸣谢与设计参考

感谢以下开源项目提供的设计参考：

| 项目 | 参考内容 |
| --- | --- |
| [pi-control-chrome](https://github.com/lyd123qw2008/pi-control-chrome) | 稳定元素引用、Chrome 无障碍名称、条件等待 |
| [mcp-chrome](https://github.com/hangwin/mcp-chrome) | Chrome 调试会话、文件选择、弹窗与下载状态管理 |
| [codex-control-chrome-mcp](https://github.com/iola1999/codex-control-chrome-mcp) | 会话生命周期、连接故障分类 |

具体参考版本、独立实现范围和差异记录在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。WorkBuddy 为早期功能流程参考；本项目与这些项目及其维护者无隶属或背书关系。

打包形式参考 [OpenAI 插件文档](https://developers.openai.com/plugins/build/plugins) 和 [本地 MCP 配置](https://developers.openai.com/plugins/deploy/desktop-only#configure-a-local-mcp-server)。

## 参与与许可证

欢迎通过 [Issues](https://github.com/niu1147713149-png/codex-browser-use/issues) 报告问题或提出需求，也欢迎提交 Pull Request。开发和验证方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，漏洞报告方式见 [SECURITY.md](SECURITY.md)。

项目按 [MIT License](LICENSE) 开源，允许使用、修改、分发和商用；分发时保留许可证要求的版权及许可声明。版本变化见 [CHANGELOG.md](CHANGELOG.md)。
