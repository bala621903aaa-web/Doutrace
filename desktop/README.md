# 抖音私聊档案桌面子项目

版本 `0.3.0`。此目录与旧版 Chrome/Edge 扩展隔离，拥有独立依赖、TypeScript 配置、测试和发布目录。

2026-10-08 已完成一次[整体架构复核](ARCHITECTURE-REVIEW-2026-10-08.md)，修正了首个新页面提交前丢失旧游标、历史终点非原子完成、补修进度过期、附件重试按钮、桌面 IPC 来源边界和历史请求回放边界。当前类型检查与测试通过；标准桌面构建因 P1 发布门关闭而失败关闭。隔离的 Windows x64 portable smoke 包已完成合成数据启动、preload/IPC 与 SQLite 检查，但不代表获得发布资格。当前构建尚未用产品入口读取用户旧档案或完成离线页面人工验收。

## 当前桌面版状态（2026-10-08）

P1 汇总当前判定为 `inconclusive`，实现版本不匹配，P2 门关闭；以当前 [P1 验收汇总](P1-ACCEPTANCE-SUMMARY.md) 为准。根目录检查通过（5 个测试文件、8 项），桌面类型检查通过，桌面测试通过（23 个文件、135 项）。标准桌面构建在 TypeScript 编译和静态文件复制后，于 `release-validation-p1-gate-closed` 失败关闭。另行生成的 portable smoke 包在 Electron 中通过合成数据启动、受限 preload/IPC、原生 SQLite 和 schema v5 完整性检查；这不替代 P1 真实证据，也不开放发布门。此前文档中的 P1 通过记录是 2026-10-06 的历史快照，不代表当前门状态。当前 portable 尚未用产品入口读取用户旧档案；离线页面搜索、引用、图片和语音仍需人工验收。档案完整度应依据产品报告判断，不能仅凭构建成功宣称完整。详见[架构复核](ARCHITECTURE-REVIEW-2026-10-08.md)。

## 桌面版使用

从项目根目录运行 `npm run desktop:dev` 会编译并启动本地模拟开发版，或启动已通过发布验证的交付版。开发版使用 `desktop/.desktop-data/mock-dev/` 中的隔离模拟数据；真实账号浏览器连接、采集、补修和联网自动化均被禁用，不能用于真实 P1 验收。交付版应用数据固定保存在 `%LOCALAPPDATA%\DouyinChatArchive\`：档案数据库为 `archive\archive.sqlite3`，附件为 `archive\media\`，导出默认为 `archive\exports\`，本机验收事件位于 `archive\acceptance\`。应用退出后这些文件保留；portable 放在不同目录不会因此换一套档案目录。

1. 点“连接独立浏览器”，在新开的独立配置窗口登录抖音并选中已有的单人私聊。账号登录仅在浏览器中完成，不要复制 Cookie、密码或 Token。
2. 回到桌面应用点“刷新会话”，选择会话和已有档案。勾选“从已保存游标恢复”后点“开始 / 继续”；如需稳定停在一个已提交页面后，可预先勾选“提交 1 页后自动停止”。手动“停止”则会在当前页提交边界处生效；两种方式都可从已保存游标续接。
3. 要补修老档案，选择当前账号下的对应会话并点“修复此档案”。默认最多回读 6 页，只更新既有消息内容，不新增消息，也不移动正式采集检查点；可使用“取消补修”停止。
4. 选中档案即可离线搜索正文或发送者、查看引用和媒体状态。点“导出 ZIP”并通过系统保存对话框选择位置。导出报告会分别说明历史范围、正文和附件完整度；`complete=false` 的档案仍可阅读，但不可描述成全量完整。

离线档案中保存了正文不代表历史范围已经完整，附件签名有效也不代表浏览器已经解码或听到声音。图片在真实显示后记录解码事件；音频会分别记录 metadata、播放推进、ended 和错误，不会自动播放。发布前应在最终 portable 与实际导出页上人工确认媒体显示、播放和采集恢复。

## 当前门槛

截至 2026-10-08，P1 真实验收 suite `p1-sol-final-20261004` 的当前汇总为 `inconclusive`，实现版本不匹配，P2 门关闭；八项当前均缺少与源码散列匹配的完整真实报告。以 [验收汇总](P1-ACCEPTANCE-SUMMARY.md) 及 [真实复检记录](P1-SOL-RECHECK.md) 的当前内容为准。2026-10-06 的 P1 通过记录属于历史快照。

历史 P0/P1 探针使用独立 Chrome/Edge 配置目录，并将诊断报告限制为脱敏结构。正式应用仅在发布门资料有效时开放联网采集、旧档案补修和附件重试；离线阅读与导出在发布门无效时仍可用，并会显示原因。

正式采集走已冻结并通过 P1 的 IM 历史读取适配器，不会切换为 DOM 滚动采集或模拟适配器。

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
npm run desktop:build:dev
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

汇总先排除版本已失效的证据，再选择当前版本报告；旧报告保留并列出排除原因。同一 suite 的有效通过项还必须关联到同一个账号指纹。当前汇总尚无可用的版本匹配真实分项报告，不能继续 P2～P5 或宣称发布就绪。

探针报告保存于 `%LOCALAPPDATA%\DouyinChatArchive\probe-reports`。报告只用于调查适配能力，不能单凭“观察到 JSON 请求”宣布历史分页、引用或消息类型已支持。

2026-10-03 已对照三个 GitHub 参考项目增强探针，新增 `observations.historyProtocol` 脱敏语义证据。它仍只观察首屏请求，不主动翻页，所有结果保持 `p1Passed: false`。大整数以 BigInt 处理，匿名指纹仅能在同一次探针报告内关联。字段解释、冲突与下一轮验收见 [P1-REFERENCE-RESEARCH.md](P1-REFERENCE-RESEARCH.md)。

已有脱敏报告可离线对照候选字段结构：

```powershell
npm --prefix desktop run research:check -- "脱敏探针报告的完整路径.json"
```

本轮对照结果保存在 [P1-REFERENCE-CROSSCHECK.json](P1-REFERENCE-CROSSCHECK.json)。结构匹配不能替代三页历史、时间单位或终点实测。

## 发布隔离

开发构建位于 `desktop\dist`，Windows x64 便携包位于项目根目录的 `desktop-release`；不会覆盖旧扩展的 `dist` 或 `release`。
