# 抖音私聊导出工具：交接进度

更新时间：2026-10-04  
工作目录：`C:\Users\25222\Documents\ChatGPT\抖音聊天记录抓取`

## 当前状态

桌面 P1 已由 Sol 完成真实复检：suite `p1-sol-final-20261004`，八项全部 pass，`implementationMatches=true`，`p2GateOpen=true`。最新结果以 [验收汇总](desktop/P1-ACCEPTANCE-SUMMARY.md) 和 [复检记录](desktop/P1-SOL-RECHECK.md) 为准。后续交给已有 Luna 聊天继续 P2～P5，具体执行入口为 [LUNA-P2-P5-HANDOFF.md](LUNA-P2-P5-HANDOFF.md)。正式采集、SQLite、附件保存、导出界面和可用 exe 尚待实现。

桌面类型检查、53 项测试与构建通过；根扩展 25 个源码/配置文件散列未变。以下旧扩展及各次 P1 未通过记录保留为历史，不能作为当前桌面状态。

## 旧扩展进度（历史记录）

已按第一版计划搭建并实现一个本地运行的 Chrome / Edge Manifest V3 扩展原型，已构建可加载目录和 ZIP 安装包。扩展按钮现在会在当前抖音聊天页内打开可拖动、可收起的悬浮面板，不再创建独立工具标签页。项目尚未在用户自己的 Chrome 或 Edge 中完成端到端冒烟测试；真实抖音私聊页面做过只读 DOM 可行性检查，但没有导出或保存真实聊天内容。后续应从浏览器实际安装与导出验证继续。

## 已完成

- TypeScript + Manifest V3 扩展，包含页面采集、扩展弹窗、后台协调、IndexedDB 本地存储、消息合并去重、附件下载，以及离线档案生成。
- 支持当前已加载消息和尽可能向前加载两种采集方式；可停止采集并导出已保存内容。无法确认历史终点时按“加载停滞”处理，不声称已导出全部历史。
- ZIP 档案包含 `messages.json`、`media/`、离线 `index.html` 和 `export-report.json`。离线页面支持关键词搜索、消息引用定位、图片查看，以及浏览器支持格式的音频播放/下载链接。
- 附件失败不会阻止文字记录导出；采集按批次本地保存，检测到会话变化会暂停，以降低混入其他会话的风险。
- 历史采集改为小步滚动并等待虚拟列表更新；批次对齐失败时会自动回找重叠消息并重试最多 3 次，降低因滚动过快而停滞的概率。
- 完成安装与使用说明、构建及打包脚本，并生成安装包：
  `release\douyin-chat-archive-0.2.0.zip`
- 扩展按钮改为向当前抖音页注入隔离悬浮面板；面板使用扩展 iframe 保持本机档案数据库和导出逻辑运行在扩展自己的来源下，支持拖动和收起。

## 真实页面检查结果

用户在 Codex 内置浏览器中登录抖音并打开了目标私聊页面（`https://www.douyin.com/chat?isPopup=1`）。只读检查观察到：

- 会话标题可从 `.RightPanelHeaderinfoContainer` 读取；当前会话项使用 `.conversationConversationItemwrapper.conversationConversationItemcurConversation[data-e2e="conversation-item"]`。
- 消息行是 `.messageMessageBoxmessageBox`，方向类 `.messageMessageBoxisFromMe`；纯文本位于 `.TextMessageTextpureText`，时间提示为 `.MessageBoxTimetimeLayout`。
- 消息列表 `.messageMessageListlist` 会虚拟化/改变已渲染行数。滚动列表时能继续向前加载；当前 DOM 的排列顺序与聊天时间顺序相反。页面 DOM 中未发现可用的平台消息 ID。
- 图片节点位于 `.MessageItemImageImageBox img`。观察到的样本是页面内嵌的 base64 PNG data URI；采集代码已处理 data image，但尚未把真实样本写入 ZIP 并离线复核。
- 检查过的历史区域未发现语音/音频消息节点，因此语音路径仍未在真实样本上验证。代码可识别页面暴露的 `audio[src]`，但不能据此宣称已支持抖音语音消息的真实提取、解码或离线播放。
- 检查期间没有观察到可信的“历史已到尽头”标记；历史加载停止时目前只能报告停滞。

## 验证记录

以下本地检查已通过：

- `npm run check`：TypeScript 检查通过。
- `npm test`：5 个测试文件、8 项测试通过。
- `npm run build`：扩展构建成功。
- `npm run package`：ZIP 打包成功。
- `npm audit --omit=dev`：生产依赖 0 个已知漏洞。全依赖审计曾报告 2 个 moderate 级开发/传递依赖项，尚未升级处理。

Chrome 外部浏览器连接曾超时。此前检查显示浏览器客户端相关组件状态正常，但没有完成 Chrome/Edge 中的扩展运行验证。Codex 内置浏览器中的登录状态也不会自动共享给用户 Chrome/Edge 扩展运行环境。

## 建议接续步骤

1. 在用户自己的 Chrome 或 Edge 中重新加载最新的未打包扩展目录，打开抖音私聊并点击扩展图标；确认悬浮面板能在当前页面出现、收起和拖动，并能识别已登录的抖音私聊。
2. 先用“当前已加载消息”完成一次小范围导出，再检查报告、双方身份、消息顺序、正文和时间；条件允许时抽查至少 100 条。
3. 测试“尽可能向前加载”：检查跨批次边界的重复/遗漏、滚动推进和停滞报告；在停止或刷新后确认已保存内容仍可导出。
4. 用真实图片完成一次 ZIP 导出并断网打开，验证图片确实在 `media/` 中、离线页面能显示。当前检查到的是 data URI 图片，需验证从页面提取到存储再到 ZIP 的完整链路。
5. 找到一条真实语音消息后检查其 DOM/资源格式，验证保存原文件及离线播放或下载。如果页面不暴露可保存的音频资源，记录具体限制，不尝试绕过平台访问控制。
6. 评估会话标识：当前会话键由站点来源与可见标题生成，同名联系人存在冲突风险；可行时改用页面提供的稳定会话标识。
7. 完成 Chrome 和 Edge 冒烟测试后，再决定是否调整解析器、安装说明或发布包。

## 常用命令与文件

```powershell
npm install
npm run check
npm test
npm run build
npm run package
```

- 安装说明：`public\README.md`
- 清单与弹窗：`public\manifest.json`、`public\app.html`、`public\app.css`
- 页面解析/采集：`src\douyin-dom.ts`、`src\content.ts`、`src\capture.ts`
- 存储、附件、导出：`src\store.ts`、`src\media.ts`、`src\export.ts`
- 测试：`tests\`
- 可加载构建：`dist\`（直接加载构建目录）；ZIP 解压后目录为 `douyin-chat-archive\`
- 安装 ZIP：`release\douyin-chat-archive-0.2.0.zip`

## 桌面版 0.3.0 实施检查点（2026-10-02）

桌面子项目已独立建立于 `desktop\`，未覆盖旧扩展。P0 基线保护完成：根目录 `npm run check` 和 `npm test` 仍通过，旧测试保持 5 个文件、8 项测试；桌面子项目的类型检查、测试、构建和最小 Electron 启动冒烟也通过。

P1 真实数据验证已使用用户正常登录的独立 Chrome 配置完成只读探针调查。真实页面确实发出 IM Protobuf 请求（包括 `/v1/message/get_by_conversation`、`/v1/message/get_message_by_init`），并暴露 `conversationStore`、`openImConversation` 等 SDK 候选；但尚未证明三页无滚动历史分页，也未解释平台消息 ID、时间单位、游标、历史终点、视频分享、表情、语音或真实引用关系。因此 P1 未通过，已停止 P2 及后续桌面功能开发，不使用滚动采集或模拟适配器冒充完成。

详细报告：`desktop\P1-VERIFICATION-REPORT.md`。桌面阶段记录：`desktop\PROGRESS.md`。

## 桌面版 P1 参考资料接续（2026-10-03）

已调查用户提供的 TeamBreakerr/douyin-chat-export、my-jxy/douyin-im-export 和 lukylong/DyAuthReply，并核对其引用的上游 `.proto`。历史请求、响应和消息字段已获得可复核候选映射；与原真实脱敏报告结构匹配。发现参考实现的时间/类型解释有冲突：消息第 4 字段应作为会话索引调查，第 10 字段及扩展时间尚需真实校准。

新增 `desktop\P1-REFERENCE-RESEARCH.md`、`desktop\P1-REFERENCE-CROSSCHECK.json`、候选 schema、只读协议语义观察和离线 `research:check` 命令。新版 `desktop:probe` 只观察页面自行加载的首屏，报告保留脱敏计数和本次运行的匿名 ID/游标关联；没有主动三页读取能力。

根类型检查、8 项测试、构建通过；桌面类型检查、13 项测试、构建通过。本轮没有新的真实浏览器历史读取，合成测试不计入 P1。**P1 仍未通过，P2 未启动。** 接续应先在正常登录的独立浏览器运行新版探针，校准真实字段，再实现并验证同一会话无滚动连续三页、终点及游标恢复。

## 当前主动验证器状态（2026-10-03）

桌面独立验证器已完成 P1.1～P1.8 的代码骨架和真实运行设施，入口为 `npm --prefix desktop run verify:history -- --pages 3`，恢复入口为追加 `--resume`。它使用独立浏览器配置、内存中的新鲜 Protobuf 请求模板和本机私有最小检查点；不会读取旧报告作为请求模板，不滚动、不发送消息，也未接入旧扩展正式采集。

真实证据已证明真实通道、账号/会话身份、平台消息 ID、无滚动连续三页、部分消息语义和重启游标恢复；真实时间单位/页面时间交叉核对和历史终点仍未通过。当前报告与缺口以 `desktop\PROGRESS.md` 及 `%LOCALAPPDATA%\DouyinChatArchive\probe-reports` 为准。正式采集保持关闭，P2～P5 未启动；下一步仍需在独立 Chrome 中选定较短单人会话并提交验证确认。

## Luna 执行计划（2026-10-03）

已生成 [LUNA-EXECUTION-PLAN.md](LUNA-EXECUTION-PLAN.md)，列出 P1 实施步骤、真实验收条件及通过后的 P2～P5 顺序。主动 `verify:history` 此后已实现；最新接续任务见下节。本次计划更新未执行新开发或改变 P1 判定。

## P1 fresh audit 代码复核与接续计划（2026-10-03）

复核 08:05:47 普通报告与 08:01:01 恢复报告及当前实现。普通运行不执行恢复，而单次总门要求所有项 pass；短会话也没有独立终点验证模式。旧恢复报告记录 `resume-boundary-disjoint` 却仍判恢复 pass，缺少同游标控制页对账，不能直接当作完整恢复验收。

最新执行入口：[LUNA-P1-CLOSEOUT-PLAN.md](LUNA-P1-CLOSEOUT-PLAN.md)。先拆分验证任务和版本化汇总、隔离检查点、加强恢复基准对账，再定位时间归属并用独立短会话验证终点。三页、时间、终点、恢复和消息类型可用同账号不同既有会话分别验证，不能混成一条采集历史或跳过真实证据。

本次仅更新计划与交接文档，未修改程序、重跑真实浏览器验证或测试；P1 未完成，正式采集及 P2～P5 保持关闭。

## P1 closeout 验证器修正（2026-10-03）

已完成 `LUNA-P1-CLOSEOUT-PLAN.md` 要求的离线验证设施修正和回归检查：

- `desktop/src/probe/verify-entry.ts` 支持 `chain / time / endpoint / recovery / semantics` 分项命令；页数与上限分离，短会话 endpoint 不再被三页条件阻塞。
- `desktop/src/probe/verification-suite.ts` 与 `p1-summary.ts` 提供 suite/run/task、源文件散列、协议/时间映射版本、证据散列和八项汇总门；分项报告的未执行项为 `not-run`，单项 pass 不开正式采集。
- `desktop/src/probe/checkpoint.ts` 保留旧 `history.json` 但不升级，新增 suite/账号/会话/checkpoint 隔离的原子检查点与独立控制页基准。
- `desktop/src/probe/history-verifier.ts` 的 recovery 已要求实际请求游标等于 C、控制页消息 ID 顺序/输出游标/`has_more`/状态一致，并用恢复输出游标完成下一页后才保存新检查点。
- `desktop/src/probe/page-state.ts` 去除嵌套行；时间对照改为唯一正文归属、完整日期/相对日期、Asia/Shanghai 分钟精度和明确字段/单位，不再接受正文包含或裸 `HH:mm`。
- 回归结果：`desktop` 类型检查、测试和构建通过，5 个测试文件、22 项测试；根项目回归尚待本轮最终验证前再跑一次。

新命令入口：

```powershell
npm --prefix desktop run verify:history -- --suite p1-closeout --task chain --pages 3
npm --prefix desktop run verify:history -- --suite p1-closeout --task recovery --prepare --checkpoint main-boundary
npm --prefix desktop run verify:history -- --suite p1-closeout --task recovery --resume --checkpoint main-boundary
npm --prefix desktop run verify:history -- --suite p1-closeout --task time --max-pages 20
npm --prefix desktop run verify:history -- --suite p1-closeout --task endpoint --max-pages 5
npm --prefix desktop run verify:history -- --suite p1-closeout --task semantics --max-pages 20
npm --prefix desktop run verify:summary -- --suite p1-closeout
```

截至本交接点没有新格式真实分项证据；[desktop/P1-ACCEPTANCE-SUMMARY.md](desktop/P1-ACCEPTANCE-SUMMARY.md) 为 `inconclusive`，`p2GateOpen=false`。下一步需用户在独立浏览器正常登录/选择既有会话后，依次完成上述最小真实验证；八项全部真实通过后再按原计划启动 P2～P5。

## P1 最新接续：时间关联修复后（2026-10-03）

已修复 time 将旧历史响应与静态渲染行反复对照的问题：新增正常初始化响应被动解码和当前窗口关联，time 改用 `--task time --snapshots 3`，零关联即停止。页面发送方读取、严格日期/时区与唯一消息计数也已校正；未降低 P1 验收门槛。版本汇总先排除旧报告，再选择同账号的当前实现证据。

桌面类型检查、7 个文件共 40 项测试及构建通过；根类型检查、8 项测试与构建通过，根扩展 25 个源码/配置文件散列未变。用户已在内置浏览器登录，真实 DOM 核对确认了消息容器与发送方结构；当前窗口只有 4 个带日期和时分的标签，没有 DOM 平台 ID，仍不能宣布时间已验证。

最新版汇总已生成：7 份历史分项报告因源码/映射版本失效排除；当前八项均为 `not-run`，P1 `inconclusive`，P2～P5 未启动。正式分项运行尚待执行，其独立 Chrome/Edge 配置与内置浏览器登录互不共享。

**执行时以 [desktop/P1-TIME-ASSOCIATION-FIX.md](desktop/P1-TIME-ASSOCIATION-FIX.md) 的命令与顺序为准**：先 time，然后重跑 chain、recovery prepare/resume、短会话 endpoint、semantics，最后 summary。不得继续使用本文件历史段落中的 `time --max-pages 20`，也不得将被排除的旧 pass 当成最终版本证据。

## P1 最终验收通过与 Luna 接续（2026-10-04）

Sol 在额度中断后继续修复和复检，最终 suite `p1-sol-final-20261004` 使用协议映射 `p1-history-and-init-protocol-v4`、时间映射 `p1-official-ui-copy-time-v7`。全部报告由同账号、冻结实现产生，没有复活失效旧 pass 或降低门槛。

- 时间：16 个不同平台 ID 与官方页面完整 Date、字段 10 毫秒精确一致，顺序 16 次、冲突 0，两份实际加载脚本 SHA 匹配。
- 读取与消息：三页无滚动、账号/会话身份、平台 ID；文本、图片、表情、语音、视频分享/文件信号及显式引用均通过。
- 恢复：准备进程退出后另启进程，同游标控制页、恢复输出游标和下一页续传一致。
- 终点：另一条较短会话历史 7 页/325 条，末页 `has_more=false`，25 条同游标重读 ID、顺序及会话身份一致。
- 汇总：八项 pass、实现版本匹配、P2 门开放。桌面类型检查、9 个测试文件/53 项测试、构建通过；根扩展 25 个源码/配置文件散列未变。

不可变真实报告链接均在 [desktop/P1-SOL-RECHECK.md](desktop/P1-SOL-RECHECK.md)。Luna 从 [LUNA-P2-P5-HANDOFF.md](LUNA-P2-P5-HANDOFF.md) 开始产品实现，优先复用已验证通道及开源参考，保留初始化最新消息窗口，按批事务保存消息与游标，完成真实导出和便携包实测。附件下载/播放和可用 exe 不属于此次 P1 已完成范围。
