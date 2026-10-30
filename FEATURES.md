# 功能与工具清单

Codex Browser Use 0.5.1 共提供 42 个 MCP 工具。工具参数以 `src/tools.mjs` 为准；操作页需要本任务实际返回的 sessionId/tabId。

| 范围 | 工具 |
| --- | --- |
| 连接与账号（4） | `browser_status`、`browser_info`、`browser_user_tabs`、`browser_account` |
| 会话与标签（11） | `browser_session_start`、`browser_claim`、`browser_tabs`、`browser_selected`、`browser_tab_info`、`browser_open`、`browser_focus`、`browser_release`、`browser_close`、`browser_finalize`、`browser_session_end` |
| 导航与观察（5） | `browser_navigate`、`browser_snapshot`、`browser_find`、`browser_wait`、`browser_screenshot` |
| 页面输入（11） | `browser_click`、`browser_double_click`、`browser_move`、`browser_drag`、`browser_fill`、`browser_select`、`browser_check`、`browser_type`、`browser_press`、`browser_scroll`、`browser_batch` |
| 文件与诊断（5） | `browser_upload`、`browser_download`、`browser_downloads`、`browser_dialog`、`browser_diagnostics` |
| 视频与音频（4） | `browser_media`、`browser_media_control`、`browser_media_frame`、`browser_media_audio` |
| 持久任务（2） | `browser_task`、`browser_task_step` |

先创建任务会话，读取或接管明确目标，再依据页面返回的 ref/locator 操作。fill/select/check 自动核对字段结果；点击或按键可传有区分度的 expect。结果不确定时先读取页面，不重放提交。完整流程见 [skill](skills/browser-use/SKILL.md)。

## 初始功能参考对照

对照来源：本机安装的 WorkBuddy 0.2.4 Chrome 扩展命令分发与参数。Codex Browser Use 0.5.1 提供 42 个 MCP 工具，不兼容原软件的私有通信协议。新增可靠性设计参考 [开源来源记录](THIRD_PARTY_NOTICES.md)。

0.4.0 新增 `browser_media`、`browser_media_control`、`browser_media_frame`、`browser_media_audio`：实际播放器清单、源绑定引用、播放/暂停/验证跳转、带时间的解码帧、最多 60 秒的选定播放器音轨。可通过脚本分段覆盖长视频，记录缺口并进行可选的本地语音识别，详见 [视频阅读](docs/VIDEO.md)。这些能力不依赖平台字幕，也不等于原生完整视频输入、逐帧观看或全平台可用。

| 原版浏览器接口 | Codex Browser Use 对应功能 |
| --- | --- |
| `browser.info` | `browser_info`、`browser_status` |
| `user.openTabs` | `browser_user_tabs`，按标签栏顺序、筛选及分页 |
| `tabs.claim` | `browser_claim`，定位用户指定页后接管 |
| `tabs.new/list/selected/get` | `browser_open/tabs/selected/tab_info` |
| `tabs.close` | `browser_close`，已有页需明确关闭指令与 `allowShared` |
| `tabs.finalize` | `browser_finalize`，关闭自建页，释放已有/保留页 |
| `tab.url/title` | `browser_tab_info` |
| `tab.goto/back/forward/reload` | `browser_navigate` 的四种 action |
| `tab.focus` | `browser_focus` |
| `tab.screenshot` | `browser_screenshot`，视口/整页/区域，JPEG/PNG、自动缩放和坐标元数据 |
| `cua.click/double_click/move/drag` | `browser_click/double_click/move/drag`，可信鼠标事件 |
| `cua.scroll/keypress/type` | `browser_scroll/press/type`，原生文字插入 |
| `cua.execute` | `browser_batch`，20 步上限，首错停止，报告已执行步骤 |
| `dom_cua.get_visible_dom` | `browser_snapshot`，含跨域和嵌套 iframe、开放 Shadow DOM |
| `dom_cua.click/double_click` | ref 绑定 Chrome 文档与输入目标，同源 frame 内转换坐标，可信点击 |
| `dom_cua.scroll/keypress/type` | `browser_scroll/press/type`；另提供替换文字和 select 的 `browser_fill/select` |
| 原版通道创建/续租/关闭/取消 | 映射到本地会话、Native Messaging 连接、`browser_session_end`、`browser_release` 和暂停；不复制私有协议 |
| 用户取消 debugger | 撤销该标签页的控制；后续步骤停止 |

0.3.0 新增 `browser_find`、`browser_wait`、`browser_check`、`browser_upload`、`browser_download`、`browser_downloads`、`browser_dialog`、`browser_diagnostics`。已有动作支持 locator 和可选 expect；快照支持稳定 ref、compact/maxChars/maxNodes。输入与选择自动回读，批次遇到 uncertain 停止。

明确限制：需要 Chrome 125+；仅当前 Chrome 配置中的 HTTP(S) 页面；关闭 Shadow DOM、Chrome 受限页面、系统文件窗无接口。iframe 旋转/3D 变换不支持 ref 坐标转换；跨域 frame 缺少独立 Chrome 输入目标时拒绝鼠标操作，不回退到父页面坐标。AX 和文件选择暂限顶层文档及开放 Shadow DOM；iframe 使用 DOM 定位。下载仅跟踪插件显式发起的 ID。发送、购买、删除、上传等仍按当前任务授权执行。

验证分为协议/隔离单元检查、独立 Chromium 扩展集成、已安装插件与日常 Chrome 的真实连接测试。结果分别记录在 `output/verification.json`、`output/playwright/report.json`、`output/live/report.json`；Codex MCP 工具发现记录在 `output/live/codex-discovery.json`。

0.5.0 新增 `browser_account`、`browser_task`、`browser_task_step`。相同字段值/选项和当前 URL 自动跳过，同会话同 URL 标签默认复用。任务检查点持久保存状态与请求哈希，恢复不重放输入；见 [任务与登录状态](docs/TASKS.md)。
