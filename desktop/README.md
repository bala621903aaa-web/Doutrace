# 抖音私聊档案桌面子项目

版本 `0.3.0`。此目录与旧版 Chrome/Edge 扩展隔离，拥有独立依赖、TypeScript 配置、测试和发布目录。

## 当前门槛

2026-10-04，Sol 已完成真实 P1：suite `p1-sol-final-20261004`，八项 pass，当前实现版本匹配，P2 门开放。见 [验收汇总](P1-ACCEPTANCE-SUMMARY.md) 及 [真实复检记录](P1-SOL-RECHECK.md)。后续由 Luna 按 [P2～P5 接续任务](../LUNA-P2-P5-HANDOFF.md) 实现正式采集、存储、档案界面及便携包；当前尚未交付可用 exe。

P0 已建立桌面项目骨架和只读 P1 探针。探针只使用用户正常登录的独立 Chrome/Edge 配置目录，记录脱敏的请求路径、响应结构和页面 SDK 候选名称；不会复制日常浏览器配置，不保存 Cookie、认证头、聊天正文或原始网络响应。

P1 未通过前，桌面界面不会连接模拟适配器，也不会把 DOM 滚动采集偷偷接入正式流程。

## 命令

从项目根目录运行：

```powershell
npm run desktop:check
npm run desktop:test
npm run desktop:probe
npm run desktop:verify-history -- --suite p1-closeout --task chain --pages 3
npm --prefix desktop run verify:history -- --suite p1-closeout --task recovery --prepare --checkpoint main-boundary
# 退出上一个验证进程后
npm --prefix desktop run verify:history -- --suite p1-closeout --task recovery --resume --checkpoint main-boundary
npm --prefix desktop run verify:history -- --suite p1-closeout --task time --snapshots 3
npm --prefix desktop run verify:history -- --suite p1-closeout --task endpoint --max-pages 5
npm --prefix desktop run verify:history -- --suite p1-closeout --task semantics --max-pages 20
npm --prefix desktop run verify:summary -- --suite p1-closeout
npm run desktop:dev
npm run desktop:build
npm run desktop:package
```

`desktop:probe` 会启动独立浏览器配置并打开抖音官方页面。登录和打开目标私聊均由用户在浏览器中完成；不要把密码、Cookie 或 Token 复制到聊天或终端。

`verify:history` 现在按 `chain / time / endpoint / recovery / semantics` 分项运行。`chain` 默认只做三个非空页；`endpoint` 允许短会话并以 `--max-pages` 限制上限；`recovery` 固定执行“两页→保存 C→同游标控制页→退出重启→C 恢复→恢复输出游标下一页”；`semantics` 找到本版消息类型和显式引用或达到上限即停止。所有任务都不滚动消息列表、不发送消息。

`time` 只读取页面正常初始化/加载的响应，关联当前已渲染的消息窗口，不主动读取历史页。`--snapshots` 为 1～5，默认 3；样本不足时提示在同账号切换其他已有私聊，按 Enter 追加窗口。需要至少 10 个不同平台消息 ID 的完整日期、时间、字段、单位及顺序对照；裸时分、年份未知、正文子串或索引配对不能通过。若当前响应与页面消息零关联，立即停止并报告 `window-not-covered`。详细修复说明见 [P1-TIME-ASSOCIATION-FIX.md](P1-TIME-ASSOCIATION-FIX.md)。

真实复检中已确认页面时间显示来自消息第 10 字段 `create_time`；详见 [P1-OFFICIAL-TIME-MAPPING.md](P1-OFFICIAL-TIME-MAPPING.md)。只有本次页面正常加载的官方脚本响应 SHA-256 与已核对构建一致，time 才按此显示链路选择字段 10，且仍需真实样本校准单位。相同分钟的另一个候选保留为诊断计数，不再自动当作两个字段矛盾。源版本未核对或不足 10 个唯一样本时不能通过。

完整时间采样使用 `--task time --snapshots 1 --ui-message-info`。该选项触发固定官方构建的行内“复制消息信息”功能，观察当次 copy 事件中的 DOM 选中文本，获得精确平台 ID 与完整 Date；不依赖省略日期的标签，也不读取 React 内部数据。只有聊天和复制模块的实际加载脚本散列均一致且至少十个不同消息通过身份、内容、日期、单位和顺序核对，才能通过。复制信息及原剪贴板文本仅在内存存在，诊断报告仍只保存计数与 HMAC 指纹。最终 suite 已完成 16 条真实时间对照及其余全部 P1 分项。

`--main-sequence` 在同一窗口依次执行 time、semantics、chain、recovery prepare，各自保存真实报告。只复用本进程实际观察到的同会话首屏交换，失败即停止；它要求 `--task time --snapshots 1 --ui-message-info --checkpoint <id>`，不能同时使用 resume。恢复验证仍另启进程；终点仍另选较短会话。若将来因实际协议变化需要重新审计，应使用新 suite，避免混入已冻结的最终验收：

```powershell
npm --prefix desktop run verify:history -- --suite p1-new-audit --task time --snapshots 1 --ui-message-info --checkpoint main-boundary --main-sequence
npm --prefix desktop run verify:history -- --suite p1-new-audit --task recovery --resume --checkpoint main-boundary
npm --prefix desktop run verify:history -- --suite p1-new-audit --task endpoint --max-pages 20
npm --prefix desktop run verify:summary -- --suite p1-new-audit
```

每次运行生成不可覆盖的 suite 分项报告，并把运行 ID、任务、当前代码文件散列、协议/时间映射版本、采集窗口和证据文件散列写入 `%LOCALAPPDATA%\DouyinChatArchive\verification-suites\<suite>\manifest.json`。账号、会话、消息和游标跨运行关联使用 suite 私有 HMAC；公开报告不保存正文、URL、认证材料或原始 ID。新检查点按 suite、账号指纹、会话指纹和 checkpoint ID 隔离；旧 `verification-checkpoints\history.json` 只作 legacy 参考，不会自动升级。

`verify:summary` 生成 [P1-ACCEPTANCE-SUMMARY.md](P1-ACCEPTANCE-SUMMARY.md) 和 JSON。分项报告即使自身 pass 也不会开放正式采集；八项 P1 全部有完整真实 pass，且代码/协议/时间版本与当前实现匹配，汇总的 `p2GateOpen` 才能为 `true`。

汇总先排除版本已失效的证据，再选择当前版本报告；旧报告保留并列出排除原因。同一 suite 的有效通过项还必须关联到同一个账号指纹。本轮已冻结源码并重新执行完整真实任务，当前八项均与实现版本匹配。

探针报告保存于 `%LOCALAPPDATA%\DouyinChatArchive\probe-reports`。报告只用于调查适配能力，不能单凭“观察到 JSON 请求”宣布历史分页、引用或消息类型已支持。

2026-10-03 已对照三个 GitHub 参考项目增强探针，新增 `observations.historyProtocol` 脱敏语义证据。它仍只观察首屏请求，不主动翻页，所有结果保持 `p1Passed: false`。大整数以 BigInt 处理，匿名指纹仅能在同一次探针报告内关联。字段解释、冲突与下一轮验收见 [P1-REFERENCE-RESEARCH.md](P1-REFERENCE-RESEARCH.md)。

已有脱敏报告可离线对照候选字段结构：

```powershell
npm --prefix desktop run research:check -- "脱敏探针报告的完整路径.json"
```

本轮对照结果保存在 [P1-REFERENCE-CROSSCHECK.json](P1-REFERENCE-CROSSCHECK.json)。结构匹配不能替代三页历史、时间单位或终点实测。

## 发布隔离

开发构建位于 `desktop\dist`，Windows x64 便携包位于项目根目录的 `desktop-release`；不会覆盖旧扩展的 `dist` 或 `release`。
