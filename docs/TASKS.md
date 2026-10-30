# 登录环境、减少重复操作与任务恢复

0.5.x 使用安装扩展的原生 Chrome 配置。Cookie、本地存储和网站的刷新机制仍由 Chrome 与网站管理，不导出 Cookie，也不改变登录有效期。不同浏览器会话隔离的是标签归属，仍共享同一配置中的网站登录状态。

## 观察与操作

- `browser_fill` / `browser_select` 先检查真实值，相同时返回 `changed:false`，不发送输入/change 事件。`browser_check` 沿用相同状态不点击。
- `browser_open` 默认复用本会话中 URL 完全一致的唯一标签，不接管其他会话或用户的未共享标签。确需新建第二张同 URL 页时传 `reuse:false`。多个候选需要指定 tabId。
- `browser_navigate(action:goto)` 在当前 URL 一致时跳过重新导航，显式刷新使用 `reload`。
- 原生点击继续等待可见、可用、无遮挡且位置稳定。填入文本使用 Chrome 输入通道；不会为了模仿人而增加随机抖动和无意义等待。

## 配置与账号

`browser_info` 和 `browser_session_start` 返回持久的 `profileId`。这是该 Chrome 配置中扩展安装的随机标识，不是 Chrome 的真实配置名、磁盘路径或 Google 账号。重新连接时把此前观察到的 ID 传给 `browser_session_start(expectedProfileId)`，不匹配会停止。弹窗显示该标识的短形式。卸载扩展或清除扩展本地数据会改变它。

账号观察和任务另外记录标签页的 incognito 状态，不能把普通窗口的任务恢复到无痕窗口，或反向混用。

`browser_account(sessionId,tabId,rules?)` 只读取当前已接管页面的账号证据：

- `signed_in`：找到了站点自己的已登录导航控件；不等于服务器认证永久有效。
- `signed_out`：找到了明确的登录入口。
- `unknown`：没有适配规则、控件缺失、证据冲突或目标不唯一。
- `account.fingerprint`：仅在可见控件还提供了身份时返回。没有 fingerprint 时只能确认登录迹象，不能保证具体是哪一个账号。

内置 X 的账号切换入口及个人资料链接、YouTube 顶栏头像/登录入口。其余站点（包括未匹配的抖音页面）先 snapshot/find，传入实际观察到的导航控件，例如：

```json
{"rules":{"signedIn":{"testId":"observed-account-menu"},"signedOut":{"role":"button","name":"登录"},"identity":{"testId":"observed-my-profile-link"}}}
```

这只是参数形状，不能把示例 locator 直接当成真实页面元素。不要使用视频作者头像、推荐账号或评论作者充当当前登录身份。不会自动打开账号菜单；如需查看，应使用正常页面交互。只检查顶层页面，不读取密码框或以 Cookie 数量推断登录。

## 有检查点的任务

1. 创建本聊天的 session，接管明确目标 tab。用 `browser_account` 核对登录证据。
2. `browser_task(action:create,name,requireSignedIn:true,accountRules?)` 返回 `taskId`；保存到本聊天。普通无需登录任务可省略 requireSignedIn。创建时能确认身份的任务会绑定该身份；否则返回 `login_status_only` 或 `profile_and_origin`，不能当作已绑定某账号。
3. 对重要步骤调用 `browser_task_step(taskId,stepId,action,args)`。它先检查期望结果，已经满足就跳过；否则先持久保存意图，再发送动作并验证。不同步骤用不同 stepId，同一步重复请求保持相同 ID 与参数。
4. 点击、双击、追加文字和按键必须提供有区分度的 `args.expect`；填值、选择、勾选和 goto 可自动推导结果条件。使用语义 locator，不接受失效的文档 ref 或坐标。页面已加载不是充分的成功条件。
5. 同一步重复请求返回历史状态且 `actionsReplayed:0`。即使当前页面后来变化，也不会自动重放已完成步骤。`uncertain` 会阻止后续步骤；先检查页面，再用 `browser_task(action:verify,stepId,condition)` 核对**原来的同一个结果条件**。核对失败保持未解决状态。没有发送输入或准备阶段滚动等操作的失败（例如定位不到元素），在成功撤销检查点后返回 `STEP_NOT_SENT`；修正请求后可用同一 stepId 重试。鼠标移动/悬停、拖拽首个移动、准备滚动都可能触发页面行为，其后的失败保留 `uncertain`；撤销检查点写入失败同样保留未解决状态，不能当作未记录而重试。
6. 原会话仍在时可以直接继续。扩展重载/Chrome 重启后，新建 session、重新列出并接管该任务页面，再调用 `browser_task(action:resume,taskId)`。它核对配置、网站 origin 和已绑定的账号证据，不自动导航、不重新发送步骤。原会话仍占用目标页时不允许另一个会话接管任务。
7. 全部步骤已确认后 `finish`；需要清理该检查点时 `discard`，不会更改网页。释放或关闭测试页仍使用正常标签工具。

检查点原会话已不再占用页面时，可在新会话的受控标签页上按本聊天保留的 taskId 执行 discard，即使原网站已退出登录；不会因此恢复或执行网页动作。

调用示例（sessionId/tabId/taskId 必须来自工具返回）：

```json
{
  "sessionId":"<本任务会话>","tabId":123,"taskId":"<本任务检查点>",
  "stepId":"submit-form","action":"click",
  "args":{"locator":{"role":"button","name":"保存"},"expect":{"state":"text","text":"已成功保存本次修改"}}
}
```

`expect` 必须代表当前任务完成，不能使用提交前就存在的泛化文字。插件确认的是可观察结果，不证明点击与结果的因果关系。对于已经发生但结果无法核实的动作，保留未解决状态；不要换 stepId 或新建任务来盲目重试。

## 持久数据与边界

检查点写入扩展 `storage.local`，仅扩展可信上下文可读。最多 30 个检查点、每个 100 步。保存任务名、站点 origin、配置 ID、可选账号指纹和定位规则、步骤 ID、请求/结果条件哈希、状态与时间；不保存原始动作参数、填写内容、网页正文、Cookie 或可以自动重放的指令。任务名与定位规则中不要放凭据。

当前恢复依赖本聊天保留的 taskId、步骤和预期条件；它不是无人值守的任务调度器。一次检查点限定同一网站 origin。导航跨站、账号变化、身份无法确认、结果条件变化都会停止；验证码和网站登录步骤由原网页流程处理。普通直接调用不具备任务步骤的持久去重，重要多步任务要使用 task 接口。

还会核对上一次观察到的页面 URL 哈希，防止同网站另一张表单接收恢复后的操作。中断的步骤若明确声明了精确 URL 结果，也允许在该目标页恢复并核查。其余未记录的跳转需要先回到原任务页面。URL 只存哈希，不保存查询参数明文。

验证入口：`node --test tests/*.test.mjs`；`node scripts/task-check.mjs <已安装MCP入口> <Chrome可执行文件>` 通过正式插件验证输入事件次数、提交去重、账号切换、原生 HttpOnly 会话复用和实际扩展重载后的恢复。重载测试只在没有其他受控会话时运行。
