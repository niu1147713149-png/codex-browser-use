# 实际视频画面与声音

0.4.0 在现有 Chrome 会话内读取 HTMLVideoElement/HTMLAudioElement，不下载完整平台视频、不提取 Cookie、不调用隐藏平台接口。画面来自播放器正在解码的视频，音频来自该元素的 captureStream。无需网页提供字幕，也不新增 Chrome 权限。

## 工具

| 工具 | 输入与结果 |
| --- | --- |
| browser_media | 返回播放器 mediaRef、文档/frame、时长、分辨率、当前时间、播放状态、可跳转区间；不返回媒体签名 URL |
| browser_media_control | 对观察到的 mediaRef 执行 play/pause/seek；seek 暂停并确认时间；不替换过期目标 |
| browser_media_frame | 返回真实 JPEG 画面、媒体时间、来源；time 可选，maxWidth 默认 1280，最大 2160 |
| browser_media_audio | start/status/read/stop/discard；明确 recordingId，单段 0.5–60 秒，WebM/Opus；来源变化/跳转/暂停中断录音 |

录音使用 1 倍速；不会读取麦克风或其他标签页音频。释放页面、暂停插件、导航会清理录音。正常结束和中途截断分别报告。画面采集不包含网页字幕覆盖层，烧录在视频画面中的文字会保留。

## 生成可核对的证据包

先通过 MCP 建立会话、打开视频、列出 mediaRef。再按真实返回值执行：

```text
node scripts/video-evidence.mjs --session SESSION --tab TAB --media MEDIA_REF --out ABSOLUTE_DIRECTORY --interval 1
python scripts/transcribe-evidence.py --manifest ABSOLUTE_DIRECTORY/manifest.json --model small
```

可用 --start/--end 限定分析区间，--interval 最小 0.25 秒。未指定 end 时使用有限视频时长。实际采集需要播放相应时长，长视频分段不等于瞬间看完。平台可能在后台暂停，先聚焦目标页。脚本结束保持暂停。

证据包包含带媒体时间的帧、原始采集音轨、SHA-256、页面快照和 manifest.json。长音轨按最多 45 秒分段，边界带短暂重叠，实际缺口原样报告。语音识别为可选本地依赖（requirements-media.txt）；模型必须事先存在本机缓存或目录，工具不会自动下载模型或调用云服务。transcript.json 中的机器识别结果附时间与来源指纹，静音/受限音轨单独标记。

必须实际查看图片并核对声音/转写后再形成内容分析。可按重要片段加密取帧；采样不能保证捕捉短于间隔的动作、画面或文字。声音转写不覆盖音乐情绪等全部听觉信息。完整视频语义理解仍取决于模型对证据的分析，插件不提供独立多模态模型。

## 限制与失败处理

- 只读取用户当前可播放的网页媒体。DRM、关闭 Shadow DOM、不可注入 frame、CORS、浏览器录制限制会导致部分能力不可用，不绕过登录或验证。
- 多个播放器必须明确选择；广告、下一条预加载视频不能自动当作目标。源切换会使 mediaRef 失效。
- 不因缺字幕降级为只总结简介；先读取画面和真实音轨。音轨不可读时保留可用画面并明确声音缺失。
- 浏览器将音轨静音、实际音频解码为全静音时，不能据此断言原视频无人说话。没有音轨、没有证据和没有语音是不同结论。
- 帧是离散样本，音轨是区间证据。报告明确已分析范围、采样密度、缺口、未查看片段，不能宣称每一帧都已看过。
- 视频评论、评论点赞等仍通过页面快照与滚动读取；不保证完整评论采集。

## 验证

`node scripts/media-check.mjs [INSTALLED_MCP_ENTRY]` 在本机创建自己的测试页面，以生成的无字幕视频验证元数据、跳转、帧差异、真实音轨解码、引用失效和中断行为。需要 FFmpeg，不控制其他用户页面。既有测试运行 `npm test`，完整浏览器回归运行 `node scripts/live-check.mjs [INSTALLED_MCP_ENTRY]`。
