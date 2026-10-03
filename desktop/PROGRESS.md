# 桌面版实施记录

**最新状态（2026-10-04）：Sol 已完成 P1，八项 pass、实现版本匹配、P2 门开放。** 见 [验收汇总](P1-ACCEPTANCE-SUMMARY.md)、[真实复检记录](P1-SOL-RECHECK.md) 及 [Luna P2～P5 接续任务](../LUNA-P2-P5-HANDOFF.md)。以下保留各轮历史记录。

## P0：基线保护（2026-10-02）

- 改动范围：新增独立 `desktop/` 子项目和根级 `desktop:*` 命令映射；未修改旧扩展源码、`dist/` 或 `release/`。
- 基线命令：根目录 `npm run check` 通过；根目录 `npm test` 通过，5 个测试文件、8 项测试通过。
- 当前桌面命令：已创建 `desktop:check`、`desktop:test`、`desktop:probe`、`desktop:dev`、`desktop:build`、`desktop:package`。
- 已证实能力：桌面项目与旧扩展依赖隔离；浏览器探针会使用独立配置目录，并在报告中脱敏网络结构。
- 未解决问题：真实页面虽然暴露 IM Protobuf 请求和 SDK 候选，但没有证明三页无滚动历史分页，也没有解释平台消息 ID、时间单位、游标和终点字段；视频分享、表情、语音和真实引用关系均未验证。

## P1：真实数据验证（2026-10-02）

- 改动范围：增强只读探针，记录脱敏请求/响应结构、嵌套 Protobuf 字段形状和页面 SDK 键名；未调用未确认的 SDK 方法，未滚动页面，未发送消息。
- 验证结果：**未通过，按停止条件暂停 P2 及后续桌面功能开发**。详细证据见 [P1-VERIFICATION-REPORT.md](P1-VERIFICATION-REPORT.md)。
- 已证实能力：页面真实使用 `/v1/message/get_by_conversation`、`/v1/message/get_message_by_init` 等 Protobuf IM 请求；页面存在 `conversationStore`、`openImConversation` 等候选对象；账号资料响应含稳定 ID 候选字段。
- 未证实能力：连续三页无滚动读取、游标持久化及推进、历史终点、平台消息 ID、精确时间、视频分享、表情、语音、真实引用关系和断点恢复。
- 停止原因：两条路线都没有形成可解释、可复核的历史分页适配；不能静默切换为 DOM 滚动，也不能把模拟实现连接到正式采集流程。

## P1：参考项目调查与只读探针增强（2026-10-03）

- 完成用户提供的三个 GitHub 项目及所引用上游 `.proto` 调查，固定提交和字段冲突记录见 [P1-REFERENCE-RESEARCH.md](P1-REFERENCE-RESEARCH.md)。
- 原脱敏报告的历史请求、响应和保留消息样本与候选字段结构匹配；响应重复消息计数为 50。对照输出：[P1-REFERENCE-CROSSCHECK.json](P1-REFERENCE-CROSSCHECK.json)。
- 已厘清候选方向：请求内层第 3 字段保持为会话短 ID，第 5 字段用于续传；消息第 4 字段按排序索引处理，第 10 字段及扩展服务端时间只作时间校准候选。
- 新增不完整候选 schema、有界只读协议解码和离线结构对照命令。探针不增加历史请求、不滚动、不清除 SDK 缓存、不读取 Cookie 或存储。
- 新版报告只保存计数和本次运行内可关联的 HMAC 指纹；缺失 `has_more` 保留未知，协议错误不判定终点。所有协议结果仍固定 `p1Passed: false`。
- 验证：根类型检查、8 项测试、构建通过；桌面类型检查、13 项测试、构建通过；原真实报告离线结构对照通过。10 项新测试使用合成数据，不属于真实 P1 证据。
- 本轮未进行新浏览器探针实测。当前可用浏览器无打开的聊天标签，旧报告不含原始值；三页读取、时间单位、历史终点、断点恢复和真实特殊消息/引用仍待验证。
- P1 仍未通过，P2 及后续桌面功能未启动。下一步先做新版首屏字段校准，再实现独立的三页只读验证器；现有 `desktop:probe` 不具备主动三页读取能力。

## P1：独立主动验证器实现（2026-10-03）

- 已新增 `src/im/wire.ts`、`src/im/protocol.ts`：有界 Protobuf wire 读写、64 位整数精确保留、重复/未知字段保留、嵌套长度重算，以及业务错误、缺失包裹层、缺失 `has_more` 和坏游标的明确状态。
- 已新增 `src/probe/session.ts`、`history-transport.ts`、`page-state.ts`、`history-verifier.ts`、`live-report.ts`、`checkpoint.ts` 和 `verify-entry.ts`。`verify:history -- --pages 3` 在独立浏览器配置中捕获新鲜首屏，并在同一正常页面会话中主动串行读取后续页；代码不发滚动或翻页键，不接入 DOM 滚动采集或模拟适配器。
- 报告同时列出通过项与缺口，保存脱敏结构、计数和匿名关联；检查点位于应用私有数据目录，不含认证材料或正文。P1 门槛独立于旧 `im-protocol.ts` 的候选交换统计，正式采集仍固定关闭。
- 已将旧 `desktop:probe` 改用共享会话生命周期，保留其被动观察职责；旧扩展源码、`dist/` 和 `release/` 未接入桌面验证器。
- 新增 64 位、嵌套长度、未知/重复字段、业务错误/坏数据以及独立门槛测试。`desktop:check`、`desktop:test`（4 个文件、18 项测试）、`desktop:build`、根 `check` 和根 `test` 均通过。
- **真实 P1 尚未判定。** 验证器已启动并等待用户在独立窗口正常登录及选择至少三页的单人会话；在取得真实交换前，P2～P5 保持关闭。

## P1：第一次真实主动运行（2026-10-03）

- 真实运行 ID：`4b668b5f-5d09-424f-8912-5832ff93f7b3`；脱敏证据：[p1-live-verification-2026-10-03T07-17-25-244Z.json](%LOCALAPPDATA%/DouyinChatArchive/probe-reports/p1-live-verification-2026-10-03T07-17-25-244Z.json)，汇总报告：[P1-LIVE-VERIFICATION-REPORT.md](P1-LIVE-VERIFICATION-REPORT.md)。
- 已取得真实成功交换：首屏及 19 次主动续传均 HTTP/业务成功；每页 50 条，消息会话和短 ID 全匹配，平台 ID 每页唯一且跨页有新增，索引跨页向更旧方向推进；真实内容信号出现文本、图片、表情、视频分享、语音、视频文件和显式引用。
- 真实判定仍为 **fail**：当前页面状态读取没有得到目标消息列表或自身 UID/当前会话证据，因此无滚动和账号/会话必验项不能通过；时间候选已记录但尚未与页面时间交叉核对；在有界 20 页内 `has_more` 仍为 true，终点未宣称；尚未执行 `--resume` 重启对账。正式采集保持关闭。
- 已针对该证据修正：允许捕获 GET 形式的自身资料响应；页面 store/DOM 读取改为容错并扩展消息列表定位；不再把 `f10` 与扩展时间候选不相等直接判成矛盾。下一轮最小动作是重新进入当前独立窗口的目标会话，取得新鲜首屏后重跑；若仍为长会话，再选同账号已有短单人会话完成终点及恢复验收。

## P1：真实主动复验与页面状态修正（2026-10-03）

- 真实正常运行 `543c0383-7d66-4cb6-bb04-168456e0c074`：首屏加 19 次主动续传均真实成功，平台消息 ID、消息语义通过；身份仍为未完成，无滚动列表和页面时间证据，20 页内仍为 `has_more=true`，终点未宣称。证据：[p1-live-verification-2026-10-03T07-29-22-333Z.json](%LOCALAPPDATA%/DouyinChatArchive/probe-reports/p1-live-verification-2026-10-03T07-29-22-333Z.json)。
- 真实 `--resume` 运行 `407805ba-486f-4561-b67d-aa9bbac74bff`：检查点存在，账号、会话、短 ID、游标均匹配，重启后边界已真实对账，`cursor-recovery` 判定 **pass**；边界关系如实记录为 `disjoint`，没有把它改写成完整历史。证据：[p1-live-verification-2026-10-03T07-31-11-246Z.json](%LOCALAPPDATA%/DouyinChatArchive/probe-reports/p1-live-verification-2026-10-03T07-31-11-246Z.json)。
- 发现并修复页面状态探针的真实运行错误：TypeScript 序列化 `page.evaluate` 函数时注入了页面不存在的 `__name` 辅助函数，导致所有 frame 被误报为不可读。现在改为不经编译器改写的只读页面脚本，并扫描主 frame/子 frame；独立配置复现结果为页面应用壳存在、`conversationStore` 存在，但当前没有消息行、消息列表或选中会话。正文不写入报告，只保存节点计数和位置证据。
- 最新正常验证器正在等待用户在独立窗口选定目标会话后按 Enter；P1 尚未通过，正式采集继续关闭，P2～P5 未启动。

## P1：真实 UI 已接通后的验收结果（2026-10-03）

- 真实正常运行 `1252ddd6-96c9-440c-8b94-8c095b922f48`：自 UID、当前选中会话、请求/消息会话与短 ID稳定一致；消息列表前后 `scrollTop=0`，三页真实游标连续且每页有新增平台消息 ID；真实文本、图片、表情、视频分享、语音、视频文件和显式引用样本均出现。`real-channel`、`identity`、`platform-message-id`、`three-pages-no-scroll`、`message-semantics` 均为 **pass**。证据：[p1-live-verification-2026-10-03T07-37-51-306Z.json](%LOCALAPPDATA%/DouyinChatArchive/probe-reports/p1-live-verification-2026-10-03T07-37-51-306Z.json)。
- 同一真实运行的时间证据保持未验证：页面实际只暴露 6 个时间标签（4 个带时钟、2 个相对时间），本轮没有达到至少十条字段/页面标签/单位/顺序交叉核对；20 页内 `has_more` 仍为 `true`，历史终点未宣称。
- 随后的 `--resume` 因用户未在重启后的独立窗口重新点击会话，没有捕获新鲜历史请求，报告为全项 `inconclusive`，没有消耗旧检查点冒充通过：[p1-live-verification-2026-10-03T07-45-11-479Z.json](%LOCALAPPDATA%/DouyinChatArchive/probe-reports/p1-live-verification-2026-10-03T07-45-11-479Z.json)。下一次最小动作是重启后重新点击同一会话并按 Enter；历史终点还需同账号已有的较短单人会话。
- P1 仍未全部通过，正式采集保持关闭；P2～P5 未启动。

## P1：时间候选校准与重启恢复实测（2026-10-03）

- 修正主动验证器的时间交叉核对：同一真实消息分别尝试 `f10` 与 `s:server_message_create_time` 扩展候选，按首次匹配的页面标签计数并记录来源；不再因候选字段数值不同直接判矛盾。桌面类型检查、18 项测试和构建通过。
- 最新正常真实运行 `8acf8884-632e-4ae4-89ca-8ac379a3d898` 的复验报告：[p1-live-verification-2026-10-03T07-51-32-185Z.json](%LOCALAPPDATA%/DouyinChatArchive/probe-reports/p1-live-verification-2026-10-03T07-51-32-185Z.json)。同一会话真实完成 20 页，但 `has_more=true`，所以历史终点仍是 `page-limit`；真实页面仍只有 6 个时间标签，`pageLabelCrossChecks=0`，发送时间未验证。
- 重启 `--resume` 真实运行 `p1-live-verification-2026-10-03T07-52-18-883Z.json`：同账号、同会话、短 ID、游标和边界对账全部通过，`cursor-recovery=pass`；该运行仍因长会话终点、时间标签和缺少语音样本保持 `inconclusive`。当前正式采集继续关闭，P2～P5 未启动。
- 最小接续动作：在新启动的独立浏览器中选择同账号已有的较短单人私聊（至少三页非空、且有明确历史终点和至少十条可对应时间标签），再按 Enter；不滚动、不发送消息。

## P1：新鲜请求等待与只读重载兜底（2026-10-03）

- 旧等待进程在未捕获新鲜历史请求时被安全取消，已保存脱敏报告：[p1-live-verification-2026-10-03T07-57-38-833Z.json](%LOCALAPPDATA%/DouyinChatArchive/probe-reports/p1-live-verification-2026-10-03T07-57-38-833Z.json)；报告明确为 `fresh-history-not-captured`，没有伪造页数或通过项。
- 主动入口新增一次有界只读页面重载兜底，并在每次尝试动态读取当前选中会话；不读取旧报告请求、不复制认证材料、不滚动、不发送消息。桌面类型检查、18 项测试和构建通过。
- 新版 `verify:history -- --pages 3` 已重新启动并等待用户在独立浏览器中选定会话后按 Enter；P1 仍未通过，正式采集保持关闭，P2～P5 未启动。
- 最新正常运行 `a25eda9f-512c-45ba-9b71-1664a4c33806`：[p1-live-verification-2026-10-03T07-59-53-519Z.json](%LOCALAPPDATA%/DouyinChatArchive/probe-reports/p1-live-verification-2026-10-03T07-59-53-519Z.json)。真实通道、身份、平台 ID、三页无滚动（含 2 次跨页位置对账）和全部本版消息语义通过；但该长会话在 20 页后仍 `has_more=true`，页面时间交叉核对为 0，历史终点和发送时间未验证。
- 最新恢复运行 `3c6031eb-85af-4ddd-a98f-cd3d1c41597f`：[p1-live-verification-2026-10-03T08-01-01-821Z.json](%LOCALAPPDATA%/DouyinChatArchive/probe-reports/p1-live-verification-2026-10-03T08-01-01-821Z.json)。同账号、同会话、短 ID、游标和边界对账通过；恢复链本身缺少语音样本，整体保持 `inconclusive`。P1 正式门仍关闭。
- 随后正常运行 `50819f23-57c3-4c4c-933c-cb2fa6069879`：[p1-live-verification-2026-10-03T08-02-31-226Z.json](%LOCALAPPDATA%/DouyinChatArchive/probe-reports/p1-live-verification-2026-10-03T08-02-31-226Z.json)。真实三页及跨页列表位置对账通过，但仍是同一长会话：20 页后 `has_more=true`、时间页面交叉核对为 0、终点和发送时间未验证。重复启动不再增加证据；最小动作是明确切换到同账号另一条较短单人私聊。
- 为下一轮真实验收扩展页面时间探针：在不保存原文的前提下，额外检查消息行内真实 `time`、`datetime`、`title`、`aria-label`、`data-time` 和 `data-timestamp` 属性，仅保留时间形状与计数；桌面类型检查、18 项测试和构建通过。该代码改进尚未被计入真实通过，仍需新鲜浏览器交换验证。
- 阻塞目标恢复后的 fresh audit 正常运行 `2f01f602-17d3-4c9b-b2bb-84b28e21b801`：[p1-live-verification-2026-10-03T08-05-47-689Z.json](%LOCALAPPDATA%/DouyinChatArchive/probe-reports/p1-live-verification-2026-10-03T08-05-47-689Z.json)。真实三页、身份、平台 ID、跨页位置和消息语义通过；实际仍为长会话，20 页后 `has_more=true`，页面时间交叉核对为 0，终点与发送时间未验证。恢复后的阻塞审计重新计数，正式采集继续关闭。

## P1 closeout：验证器修正与分项设施（2026-10-03）

- 已按 [LUNA-P1-CLOSEOUT-PLAN.md](../LUNA-P1-CLOSEOUT-PLAN.md) 拆分 `chain / time / endpoint / recovery / semantics` 五类任务。分项报告只列适用必验项，其余明确为 `not-run`；单项 pass 不再打开正式采集门。
- 新增 suite 清单和 `verify:summary`：记录 suite/run/task、当前验证器相关源文件 SHA-256、协议映射版本、页面时间映射版本、采集窗口和分项报告散列。跨运行关联使用 suite 私有本机 HMAC；旧报告格式不能凭布尔 pass 自动升级。
- 检查点改为 suite/账号指纹/会话指纹/checkpoint ID 隔离的原子文件；保留旧 `history.json` 作为 legacy 参考。recovery prepare 保存第 2 页后的游标 C，控制页单独保存；resume 必须实际使用 C、与控制页逐项对账，再以恢复输出游标完成下一页并保存新检查点。
- 页面状态去除嵌套重复消息行；时间对照只接受唯一正文归属、完整日期/相对日期、Asia/Shanghai 分钟精度和无冲突的字段/单位映射。纯 `HH:mm`、正文包含匹配、重复消息和跨日期误配均不能通过。
- 桌面类型检查、构建和回归测试通过：5 个测试文件、22 项测试。新增测试覆盖分项 not-run、终点 page-limit、控制页缺失、严格时间匹配、重复/错误日期以及隐私脱敏。
- 当前只完成离线实现与回归检查，尚未以新格式执行真实分项任务；[P1-ACCEPTANCE-SUMMARY.md](P1-ACCEPTANCE-SUMMARY.md) 当前为 `inconclusive`，`p2GateOpen=false`，正式采集和 P2～P5 继续关闭。下一步按最小顺序执行新鲜 chain、recovery、time、endpoint、semantics 真实验证，再运行 `verify:summary`。

## P1：fresh audit 代码复核及计划调整（2026-10-03）

- 核对上述 fresh audit 和 08:01:01 恢复报告。发现普通模式的恢复项固定未执行，而报告总门要求单次全部通过；应实现分项验证与有身份/版本依据的验收汇总。
- 旧恢复报告有 `boundaryRelation=disjoint` 和 `resume-boundary-disjoint`，但恢复项仍为 pass。当前仅比较 ID 交集/索引范围，缺少重启前同游标下一页基准；旧恢复证据应保留并补充其局限，不能直接搬入新的完整验收。
- 页面候选行可能重复，时间依赖正文包含匹配和纯时分比较，后续需校准消息与时间归属、完整日期与单位，并按唯一消息计数。短会话应独立验证终点，不必同时满足三页或全部消息类型。
- 新执行计划：[LUNA-P1-CLOSEOUT-PLAN.md](../LUNA-P1-CLOSEOUT-PLAN.md)。原主计划已更新现有验证器和命令状态；P2～P5 范围沿用原计划。
- 本次只更新文档，没有程序改动、新的真实采集或测试运行。P1 仍未完成，正式采集关闭，P2～P5 未启动。

## P1：Sol 修复时间窗口关联与版本汇总（2026-10-03）

- 核对 Luna 时间报告：20 页始终对照同一渲染窗口，累计页面行计数包含重复；原观察器漏解码正常初始化消息。新增被动初始化解码、同会话窗口合并及独立 time 任务，零关联时立即报告缺口，不再继续主动读取旧页。
- 校准消息行与内容框的发送方样式；时间对照要求显式 ID 或唯一完整正文、同发送方及顺序证据。保留完整日期、时区、字段/单位、至少 10 个唯一平台 ID 的门槛，排除重复正文、裸时分及冲突候选。
- 汇总先排除失效版本，再选择当前实现证据，并核对所有通过项关联同一账号。协议/时间映射已升级，原 chain/recovery 等 pass 必须最终源码冻结后重跑。
- 用户登录内置浏览器后，只读核对到真实 13 个消息容器、11 个文本容器、6 个时间节点；只有 4 个含相对日期与时分，消息行未暴露平台 ID，发送方标记确在内容框。该 DOM 核对不等于时间字段校准或八项 P1 通过。
- 桌面类型检查、40 项测试和构建通过；根类型检查、8 项测试和构建通过。根扩展 25 个源码与配置文件散列与本轮修改前一致。
- 已重生成 [P1-ACCEPTANCE-SUMMARY.md](P1-ACCEPTANCE-SUMMARY.md)：7 份历史分项证据因版本失效被排除，当前八项 `not-run`，总判定 `inconclusive`，P2 门关闭。本轮尚未执行最终版本的真实分项 suite。
- 接续入口与具体命令：[P1-TIME-ASSOCIATION-FIX.md](P1-TIME-ASSOCIATION-FIX.md)。time 使用 `--snapshots 3`；正式命令使用应用独立浏览器配置，其登录状态与内置浏览器独立。

## P1：Sol 继续最终真实复检（2026-10-04）

- 用户明确 P1 由 Sol 完成，通过后再交给 Luna。额度中断前 time 三个窗口累计只有 4 条完整时间标签，报告保持未通过；未降低至少十个不同平台 ID 的门槛。
- 复核固定官方构建的行内“复制消息信息”功能及复制模块，新增只读 copy 事件 DOM 选中文本观察；身份、内容、完整 Date 与数值时间严格对账。报告仅计数与 HMAC；临时监听器清除，原剪贴板文本恢复，不读取 React 内部状态、不修改消息、不滚动。
- 最终时间映射 `p1-official-ui-copy-time-v7`，suite `p1-sol-recheck-20261004`。真实 time `6e1e7697-b208-487a-af1c-a0372f277c2d`：14 个不同 ID，14 条完整时间/字段 10 毫秒精确对照，14 次顺序检查，冲突 0，两份实际加载脚本散列一致，位置不变，`sent-time=pass`。
- 真实 chain `5e5a9332-d94c-4c85-9049-b4ef9d001dd5`：3 页，真实通道、账号/会话身份、平台 ID 和三页无滚动全部 `pass`；与 time 的 suite 账号关联一致。
- 恢复准备 `806a159a-1b3d-464a-a2e4-4fb7ab853056` 已成功保存检查点和同游标控制页，错误 0；正常准备进程没有重启恢复证据，因此报告如实 `inconclusive`。新进程 resume 正在执行；短会话 endpoint、semantics、summary 继续待验。
- 桌面类型检查、8 个测试文件共 50 项测试、构建通过；根扩展 25 个源码/配置文件散列复核未变。实现已冻结，后续文档及测试类型标注变化不改变已保存实现证据。
- 详细不可变报告与复检进度：[P1-SOL-RECHECK.md](P1-SOL-RECHECK.md)。当前尚未开放总 P1/P2 门，P2～P5 未启动。

## P1：最终冻结实现全部真实通过（2026-10-04）

- 修复 endpoint 到达结束页时丢失选中会话身份，以及有界上限仍有更多消息却未记录 `page-limit` 的状态错误。代码冻结后使用新 suite `p1-sol-final-20261004` 完整重验。
- 同窗口主序列 time `0fe065df-7d98-48ac-98c3-2b59a2ef730e` 取得 16 个不同平台 ID 的完整日期及字段 10 毫秒精确对照；两个官方脚本实际加载散列匹配，顺序通过、冲突 0、原剪贴板文本恢复。
- semantics `af499996-c199-41fd-bac9-5337983e42df` 三页/150 条，六类消息信号与显式引用通过；chain `03b1e47c-003a-4ccd-8a2b-e6a3e04296df` 的通道、身份、平台 ID、三页无滚动四项通过。
- recovery prepare `e295725d-73e0-4851-9b63-9fcaaa1c68e9` 保存控制页后退出；新进程 resume `dd4ac000-5e36-41bd-8561-5ee899e2bf2d` 同账号/会话/短 ID/游标/版本、控制页、恢复输出游标和下一页全部通过。
- endpoint `440bbe84-6f47-4fd8-b6c5-221b1ea7a228` 在同账号另一会话完成 7 页/325 条历史，第 7 页明确结束；末页 25 条重读身份、消息 ID 及顺序一致。
- [验收汇总](P1-ACCEPTANCE-SUMMARY.md) 与 [JSON](P1-ACCEPTANCE-SUMMARY.json) 八项 pass，`implementationMatches=true`，`p2GateOpen=true`。准备报告保持 inconclusive，只采用真正重启恢复报告作为通过证据。
- 桌面类型检查、9 个测试文件/53 项测试、构建通过；根扩展 25 个源码/配置文件散列再次核对未变。此次完成 P1，产品存储、附件下载、导出和 exe 接续交给 Luna。
