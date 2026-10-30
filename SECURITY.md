# 安全与数据说明

## 支持范围与问题报告

当前维护分支为 0.5.x，安装支持 Windows + Chrome。项目尚未经过独立安全审计。

仓库的 **Security → Report a vulnerability** 入口存在时，优先使用 GitHub 私密漏洞报告。若尚未启用，可提交不含利用细节或私人数据的 Issue，请维护者提供私密联系渠道。不要在公开 Issue 粘贴 Cookie、Token、完整网页快照或配置备份。一般问题可使用 Bug report 模板。

## Chrome 权限用途

| 权限 | 用途 |
| --- | --- |
| `tabs`、`tabGroups` | 列出标签元数据、管理任务标签和分组 |
| `scripting`、HTTP(S) host 权限 | 在受控页面读取正文、定位元素和读取媒体 |
| `debugger` | 原生输入、截图、顶层 Chrome AX、文件 input 和按需诊断 |
| `nativeMessaging` | 连接当前 Windows 用户的本机桥接程序 |
| `storage` | 会话归属、配置标识与任务检查点 |
| `alarms` | 本机连接维护 |
| `downloads` | 用户指定文件下载及对应 ID 的状态查询 |

manifest 的 `key` 是固定扩展 ID 的公钥。私钥未保存在项目中。项目没有 Cookie 或密码读取工具，登录态由安装扩展的 Chrome 配置自然复用。

## 数据在哪里

- Chrome `storage.session` 保存当前会话与标签归属；浏览器重启后需要新建会话。
- Chrome `storage.local` 保存配置标识与任务检查点。检查点包含站点 origin、名称、可选账号指纹、定位规则、请求/结果哈希和状态，不保存原始填写参数或可重放动作。任务名和定位规则本身可能含个人信息，按需 discard 清理。详见 [TASKS](docs/TASKS.md)。
- `%LOCALAPPDATA%\CodexBrowserBuddy\` 保存本机启动器、host manifest 和连接凭据；安装备份可能包含旧的 Codex 私密配置，不应分享。
- 网页快照、截图、媒体帧等工具结果会进入 Codex 对话。证据脚本会将选定内容写到指定输出目录；默认开发报告在被 Git 忽略的 `output/`。
- 本机传输不依赖额外云服务；Codex 对话处理仍取决于所使用的 Codex 服务与配置。可选语音转写在本地运行，模型需预先准备。

## 控制边界

普通网页不能直接调用受鉴权的本机端口。服务只监听回环地址，检查 Host、拒绝 Origin 请求。该机制不防御同一 Windows 用户下具有文件读取能力的恶意本地程序。

标签归属、暂停和释放防止后续未经授权的控制；它们不能撤回已发送的输入。账号观察来自页面证据，不是服务端身份认证；缺少证据返回 unknown。验证码、DRM 和站点访问限制不能靠本插件保证解决。

准备发布时，Git ignore 与发布检查会排除运行数据、检测常见凭据格式和本机路径。检查不会覆盖所有秘密格式，提交前仍需人工核对文件及历史。
