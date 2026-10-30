# 参与开发

建议先阅读 [README](README.md)、[功能清单](FEATURES.md) 和 [安全与数据说明](SECURITY.md)。保持修改范围明确；功能变化需要同步工具契约、skill 和相关文档。代码使用 JavaScript ESM，浏览器控制运行时只依赖 Node.js 标准库。

## 本地检查

在项目根目录使用 Node.js 22+：

```powershell
npm ci --ignore-scripts
npm run check
npm test
```

`check` 校验清单、版本、扩展身份、图标及 JavaScript 语法。单元测试覆盖协议鉴权、标签归属、输入契约、媒体引用、任务恢复和发布文件检查，不连接个人 Chrome。

提交前审查 `git diff`，将需要提交的文件暂存后运行 `npm run check:release`。该命令读取 Git 暂存对象；修改文件后需重新暂存再检查。扫描只覆盖已定义的路径规则和常见凭据格式，不能替代人工审查。

## 浏览器集成测试（可选）

隔离浏览器测试使用一次性 Chromium 配置，不复用日常登录状态。Playwright 是测试依赖，不是插件运行依赖：

```powershell
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser
```

脚本替换测试配置中的 OS Native Messaging 启动环节，仍验证实际扩展、MCP、HTTP 鉴权和原生消息帧。它不证明 Windows 注册表安装成功。报告写入被忽略的 `output/playwright/`。

## 正式 Chrome 联调（手动）

先按 README 安装并连接扩展。以下命令会在当前连接的 Chrome 中创建测试标签页，结束后清理自己的测试页：

```powershell
node scripts/live-check.mjs
```

可传入已安装插件的 MCP 入口绝对路径，验证缓存中的副本：`node scripts/live-check.mjs <MCP_ENTRY>`。媒体检查 `node scripts/media-check.mjs <MCP_ENTRY>` 另需 FFmpeg；会播放合成的测试视频，不读取其他网页媒体。

任务恢复验收使用 `node scripts/task-check.mjs <MCP_ENTRY> <CHROME_EXECUTABLE>`，会实际重载扩展，必须在没有其他受控会话时执行。扩展代码有改动时，先更新 Chrome 实际加载的目录及 Codex 插件，再运行联调。不要把源码测试通过当成安装副本已更新。

Codex 工具发现可用 `node scripts/check-codex-discovery.mjs <CODEX_EXECUTABLE>` 检查。不要将此类已登录环境检查放入 CI。

## 目录

| 路径 | 用途 |
| --- | --- |
| `extension/` | Chrome Manifest V3 扩展、页面操作与弹窗 |
| `src/` | MCP 工具定义、stdio 服务、Native Messaging host |
| `skills/browser-use/` | Codex 调用规则 |
| `.codex-plugin/`、`.agents/plugins/` | 插件与本地 marketplace 清单 |
| `scripts/` | 安装、卸载、检查、打包与媒体证据工具 |
| `tests/` | Node.js 单元测试 |
| `docs/` | 行为契约、能力边界和发布说明 |
| `output/` | 本地测试和证据，禁止提交 |

## 修改约定

- 新动作保持 sessionId/tabId 归属校验；不得因定位失败默选第一个元素或回退活动页。
- 输入超时可能已经生效，禁止自动重放提交。新增持久字段时说明保存内容和清理方式。
- 不提交 Cookie、Token、网页截图、账号信息、安装备份或个人绝对路径。测试使用本地构造页面和虚拟身份。
- 保留扩展公钥、固定 ID 与兼容 host 名称。普通开发不需要运行 `prepare.mjs`。
- 对行为变化添加能验证用户结果或故障边界的测试。纯文档修改检查链接、命令与差异即可。
- 引入上游代码时保留许可证与版权声明，更新 `THIRD_PARTY_NOTICES.md`；设计借鉴和复制代码应分别说明。

PR 说明写清触发问题、修改后的行为、验证方法及仍未验证的环境。涉及漏洞时先参考 [SECURITY.md](SECURITY.md)。
