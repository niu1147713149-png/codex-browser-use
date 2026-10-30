# Changelog

## 0.5.0 — 2026-10-27

- 相同字段值与 select 选项不再触发重复输入；同会话同 URL 默认复用标签，goto 相同 URL 跳过刷新。
- 新增稳定 Chrome 配置标识与可观察的登录/账号状态；冲突和缺证据返回 unknown，继续复用原生登录态而不导出 Cookie。
- 新增 browser_task / browser_task_step，动作前保存检查点；重复步骤不重放，断连恢复核对原网站与账号，未确认结果阻止后续步骤。
- 共 42 个 MCP 工具；详细契约、数据保留与限制见 docs/TASKS.md。

## 0.4.0 — 2026-10-27

- 新增四个媒体工具，共 39 个：实际播放器清单、播放与验证跳转、带时间戳的解码画面、选定播放器音轨。
- 媒体引用绑定文档和源；明确录音 ID，限制时长与内存，跳转/换源/暂停/释放中断录音；不采集系统或麦克风音频。
- 新增视频证据采集脚本、分段与缺口记录、可选本地语音识别；不依赖平台字幕。
- 增加媒体协议测试和真实 Chrome 媒体回归；采样图像和音轨证据的边界见 docs/VIDEO.md。

## 0.3.1 — 2026-10-22

- 产品统一更名为 Codex Browser Use；项目、Codex 插件、MCP 服务和 skill 使用 browser-use 标识。
- 同步 Chrome 扩展名称、弹窗、标签分组、更新页面、文档与安装脚本。
- 沿用既有 Chrome 扩展 ID 与本机通信注册，支持现有安装直接升级。

## 0.3.0 — 2026-10-22

- 增加 8 个工具，共 35 个：语义查找、条件等待、勾选状态、文件选择、显式下载、下载查询、JavaScript 弹窗、受限诊断。
- 支持 role/name/label/text/placeholder/testId/CSS 定位。顶层文档使用 Chrome AX 计算名称；动作前重新校验 AX 语义。重复目标报歧义，不默认选择第一个。
- 同文档稳定 ref。节点消失时，仅允许唯一强等价节点重绑定一次；换文档、语义改变、模糊替代均拒绝旧 ref。
- 点击前等待可见、可用、无遮挡且位置稳定。输入默认使用原生 Chrome 事件，并检查实际值；支持 checkbox、radio、ARIA switch 和自定义选项。
- 新增 expect 条件。结果区分 sent / confirmed / uncertain；动作发送后只做读取验证，不自动重放。批次遇到 uncertain 停止。
- 调试连接按标签页计数，诊断与弹窗按需保留连接；不会接管或断开其他调试器。暂停、释放与用户取消会撤销后续操作。
- 精简快照支持 compact / maxChars / maxNodes。诊断仅保存最多 100 条摘要，省略 console 参数值、请求头、正文、URL 查询与片段。
- 文件选择结果明确标记 files_selected，不当作服务器已接收。下载状态仅绑定插件明确创建的 ID。

限制与使用示例见 [README](README.md)。设计来源与独立实现声明见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。

验证：协议/会话/调试器单元测试、一次性 Chromium 扩展集成、已安装 MCP 与真实 Chrome 联调；另验证 YouTube 语义搜索和本周筛选。各轮的具体结果与时间保存在本地 output/ 报告，不纳入发布包。
