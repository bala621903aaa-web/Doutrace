# P1 时间关联修复与接续

日期：2026-10-03。当前完成代码修复和离线回归，尚未完成修复后的真实 P1；P2～P5 保持关闭。

最新真实执行记录见 [P1-SOL-RECHECK.md](P1-SOL-RECHECK.md)。真实首轮已形成页面/API 关联；进一步依据官方当前脚本补齐显示字段来源，映射升级为 `p1-official-rendered-time-v5`，新回归为 41 项。以下 v4 说明保留为本轮首轮修复记录，最终接续以真实复检记录为准。

## 已确认的问题

最新 Luna 时间报告 `p1-p1-closeout-time-3e378a2d-0ae3-44a9-991f-753133cd46a1.json` 读取 20 页、1,000 条消息，但每页始终对照同一组页面候选行。累计 220 个文本行和 120 个时间行包含重复窗口，可靠时间对照仍为 0。继续读更旧的 API 历史不能增加当前页面的时间标签。

原观察器只解码 `/v1/message/get_by_conversation`。既有真实脱敏探针 `probe-2026-10-02T13-38-05-654Z.json` 还记录了正常初始化响应 `/v1/message/get_message_by_init` 的 `6 → 2043 → 1（会话）→ 2（消息）` 包裹结构。本轮依该结构新增被动解码；这属于可复核候选实现，仍须用当前真实页面验证。

## 本轮修复

- `src/im/init-protocol.ts` 校验初始化请求/响应序列与消息会话归属，精确保留 64 位消息 ID。观察器只捕获页面本次正常请求，不主动重放初始化；失败只记录固定错误码。
- `time-window.ts` 合并同页面、同会话的正常初始化与历史加载消息。按平台 ID 去重，排除身份、正文、索引或时间版本冲突；不假设索引连续。
- `time-verifier.ts` 单独采样当前渲染窗口，最多 5 次，不调用主动历史读取。零可靠关联立即停止；有可靠关联但时间样本不足时，可以切换同账号其他既有私聊追加窗口。
- `page-state.ts` 优先使用已观察到的消息行，读取内容框的发送方样式；不把卡片标题当时间，也不把通用 `data-id` 当平台消息 ID。
- `time-evidence.ts` 优先使用显式消息 ID；否则要求同发送方、完整且唯一的正文及一致的页面/API 顺序。拒绝索引配对、子串、重复正文、裸时分、年份不明及冲突日期。带时区的 ISO 时间先转换为 Asia/Shanghai，不能直接把 UTC 时钟当本地时钟。
- `live-report.ts` 按不同平台消息 ID 统计至少 10 个时间对照，记录窗口来源、关联计数、字段/单位及缺口，公开报告只保存 HMAC 与计数。
- `p1-summary.ts` 先排除失效实现版本的报告，再汇总当前证据；有效通过项必须关联同一账号。旧 pass 不再让补跑后的新报告永久被判版本不匹配。

协议版本为 `p1-history-and-init-protocol-v4`，时间版本为 `p1-visible-window-time-v4`。本轮未修改 chain/recovery 的实际续传和控制页对账要求，但其验证器源文件散列已改变，原真实通过必须重跑。

## 已完成检查

桌面类型检查、7 个测试文件共 40 项测试通过；根类型检查、5 个文件共 8 项测试和构建通过。桌面构建在最后一次源码修正后重新执行。合成测试覆盖初始化结构、真实窗口错位场景、DOM 时间归属、发送方、重复正文、日期与时区、零关联停止、脱敏及汇总版本/账号隔离，不计入真实 P1。

根扩展 25 个源码与配置文件与本轮修改前的 SHA-256 相同。`verify:summary --suite p1-closeout` 已重新执行；7 份旧分项报告均因实现/映射版本失效被排除，当前八项为 `not-run`，总判定 `inconclusive`，P2 门关闭。

用户登录右侧内置浏览器后，进行了只读 DOM 结构核对：当前确有 13 个 `.messageMessageBoxmessageBox` 容器、11 个文本容器、6 个行内 `.MessageBoxTimetimeLayout`。其中 4 个标签为“昨天＋时分”，2 个只有“前天”；均无 `datetime/title/aria-label/data-time/data-timestamp`。消息行只有 `class` 属性，未暴露平台消息 ID；自己的发送方标记位于内容框。这支持本轮选择器与发送方修正，但仅有 4 个可用时间候选，不能据此判定时间字段或单位，也没有新建真实分项通过报告。

## 真实接续顺序

首先登录并打开一条已有单人私聊，不滚动、不发送消息。右侧 Codex 内置浏览器可用于页面结构核对；桌面验证命令另使用应用自己的独立 Chrome/Edge 配置，两者登录状态独立。正式探针开始时若独立窗口要求登录，用户需在该窗口正常扫码。

冻结验证源码后，依次运行以下命令。每次按终端提示选好会话并按 Enter；recovery resume 在 prepare 进程退出后另启进程运行。

```powershell
npm --prefix desktop run verify:history -- --suite p1-closeout --task time --snapshots 3
npm --prefix desktop run verify:history -- --suite p1-closeout --task chain --pages 3
npm --prefix desktop run verify:history -- --suite p1-closeout --task recovery --prepare --checkpoint main-boundary
npm --prefix desktop run verify:history -- --suite p1-closeout --task recovery --resume --checkpoint main-boundary
npm --prefix desktop run verify:history -- --suite p1-closeout --task endpoint --max-pages 5
npm --prefix desktop run verify:history -- --suite p1-closeout --task semantics --max-pages 20
npm --prefix desktop run verify:summary -- --suite p1-closeout
```

time 可用同账号不同既有会话补足 10 个唯一消息；chain 选至少三页的已有私聊；recovery prepare/resume 必须同会话、同检查点；endpoint 明确另选已有短会话。semantics 需要当前版本的真实类型与引用证据。

若 time 仍为零关联，检查正常初始化是否被捕获、解码错误码、当前会话与窗口覆盖关系，先修复再重跑。若只有裸时分、日期不明或字段冲突，如实保持 `inconclusive`，不能降低时间门槛。修改验收相关源码后，重新生成与最终实现匹配的所有受影响证据。

只有汇总八项全部 `pass`、账号一致、证据完整且版本匹配，才可继续原 P2～P5 计划。
