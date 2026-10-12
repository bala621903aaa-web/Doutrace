# DouTrace 项目状态

最后核对：**2026-10-12（Asia/Shanghai）**。本页是可持续更新的事实索引，不替代原始报告或开启发布门。协作文档建立时只读核对源码/已有证据；此前小范围修订仅澄清流程、路径和维护责任。同日状态修订只登记 R2/R3/R4 已由未合并草稿 PR 处理，并改写下一独立开发任务；这些文档工作都没有重跑业务测试或 Electron，也不把草稿 PR 记成已合并或已验收。下文源码/测试路径均相对于仓库根目录，桌面代码统一使用 `desktop/src/`、`desktop/tests/` 前缀。

## 1. 基线与交付边界

| 项目 | 当前记录 |
| --- | --- |
| UI 产品基线 | `15d6d9243c69d54488c0b96f6e55c63b79dcc3e0` |
| 本地 UI 集成分支 | `codex/ui-v1-integration` |
| 协作文档分支（历史） | `codex/docs-ai-collaboration`，从上述产品基线创建；该文档提交不改变产品基线 |
| 未合并修复栈（本页登记） | 栈顶 `f38df49b43628d28ab31e94190d0b1f1504cfc9d`（`codex/r2-media-sources-generation-guard`，草稿 PR #2）。其下 PR #3 `a919946d9bae1e632748f3bf51a2798715cb930e`，PR #1 `29a86de8f8fe220f553b6c59330e89a675163956`。建议合并顺序 **#1 → #3 → #2**。尚未合并，待明早 Windows Electron / Integration 验收；今晚不合并 |
| 本轮状态文档分支 | `docs/project-status-r2r3r4-close`，从上述栈顶创建；只修订本文件 |
| 版本 | Desktop `0.3.0`；根目录旧扩展 `0.2.0`，见各自 package.json |
| 开发/发布资格 | `DEV_BASELINE_READY=YES`（离线继续开发）；`RELEASE_READY=NO` |
| 正式 P1 | `inconclusive`；`implementationMatches=false`；`p2GateOpen=false` |
| 开发模式 | `development-mode.json` 标记，真实连接/采集/在线补修和附件重试禁用；离线阅读/导出可用 |

用户已告知此 UI 版本推送到 GitHub 并设为默认分支。协作文档建立时没有访问远端核验默认分支，也不执行 push/merge。本次状态修订核对了当时仍打开的草稿 PR #1、#3、#2 及其完整 SHA，只开文档草稿 PR，不合并、不改默认分支。未来任务必须重新核对实际 HEAD，不能由默认分支或未合并草稿推导发布资格。

本次状态修订不改变 `DEV_BASELINE_READY`、`RELEASE_READY`、正式 P1、`implementationMatches` 或 `p2GateOpen`，也不开放采集、在线补修或附件重试。

**历史文档冲突：**`HANDOFF.md` 的 2026-10-04 P1 PASS、`desktop/README.md` 的旧测试数量/未验项是当时快照。当前正式状态取 [P1 汇总](../desktop/P1-ACCEPTANCE-SUMMARY.md)及对应 JSON、真实发布校验源码；UI 后续合成验收不能使已失效的 P1 证据复活。本轮保留旧文档及报告原件。UI 路线中的“P2 聊天分析”是开发阶段名，不等于真实采集 P2 门已开放。

## 2. 能力状态：实现与验收分别看

| 状态 | 能力与实际边界 | 代码/测试依据 |
| --- | --- | --- |
| 已完成 | 本地 Renderer 构建迁移与最小模块拆分；esbuild 把业务模块打入单一 renderer.js，另有本地 CSS/HTML/SVG | `desktop/scripts/build-renderer.mjs`、`desktop/tests/renderer-test-dom.ts` |
| 已完成 | 单 TitleBar、64px rail、五入口、分析四标签；离开档案清理媒体/失效请求，返回重载 | `desktop/src/renderer/shell/app-shell.js`、`desktop/src/renderer/renderer.js`、`desktop/tests/app-shell.test.ts` |
| 已实现；阶段 PARTIAL | 暖白/暖棕只读聊天档案、会话列表、220ms 搜索、500 条分页、当前页组合筛选/计数/空态、引用定位及高亮 | `desktop/src/renderer/{chat-archive-view,chat-archive,message-view}.js`、`desktop/src/renderer/styles/archive.css`、`desktop/tests/renderer-message-filter.test.ts` |
| 已完成离线功能验证 | 真实 Main/Preload/SQLite 的账号/会话隔离；相同昵称不同 ID 不混淆，缺 senderId/system 中性布局；内容转义 | `desktop/src/core/{archive-db,desktop-api}.ts`、`desktop/src/renderer/message-view.js`；P1-b2 身份验收 7 项 |
| 已完成离线功能验证 | 本地图片解码、音视频时间推进；持续可见节点保持、隐藏暂停/不自动恢复、离页清理，图片/音频证据回读 | `desktop/src/core/attachment-service.ts`、`desktop/src/renderer/message-view.js`、媒体相关测试及 Electron 报告 |
| 已完成基础模块 | `summarizeConversationStats`：发送者/类型/上海时区归日，未知/异常行和时间；不读取正文，只汇总传入数据 | `desktop/src/core/conversation-stats.ts`、对应 6 项测试；**尚未接入分析 UI/IPC** |
| 部分完成 | SQLite/分页采集/游标恢复/旧档案补修/附件队列/ZIP 导出代码和自动化存在；UI 管理入口保留 | `desktop/src/core/{collector,archive-repair,archive-export,attachment-service}.ts`；正式联网路径被门禁关闭，不表示当前真实采集获验收 |
| 部分完成 | ZIP 导出服务测试存在，P1-b2 实际窗口只验取消保存对话框后状态恢复 | `desktop/tests/archive-export.test.ts`；未在该轮验证实际系统保存对话框和最终 ZIP 文件 |
| 尚未实现 | 总览/互动分析真实数据展示，主动发起/回复间隔指标，聊天旅程和可追溯事件服务 | `desktop/src/renderer/index.html`、`desktop/src/renderer/shell/app-shell.js` 仅四标签空状态 |
| 代码在未合并草稿 PR #1；尚未 Integration 验收 | 「分析此会话」最小上下文：有效 `accountId + conversationId` 时复制该对并进入聊天分析 → AI 洞察，固定后不随档案筛选改写；无稳定 ID 时禁用。AI 洞察仍是诚实空状态 | PR #1 `29a86de8f8fe220f553b6c59330e89a675163956`：`desktop/src/renderer/shell/app-shell.js`、`desktop/src/renderer/renderer.js`、`desktop/src/renderer/chat-archive-view.js`、[P1B1-SHELL-CONTRACT.md](../P1B1-SHELL-CONTRACT.md) 及配套测试。不以昵称替代 ID；未合并 |
| 尚未实现 | AI 检索/模型/持久化/固定来源快照/证据抽屉 | 未有 AI 服务；上述契约不发送归档数据，也不把空状态写成真实分析结果 |
| 尚未实现 | 独立媒体管理、火花提醒引擎、设置功能页 | `desktop/src/renderer/index.html` 明确占位；已有档案媒体阅读不等于媒体管理完成 |
| 历史原型 | 根目录 `src/`、`public/` Manifest V3 扩展；独立 IndexedDB/ZIP 路径 | 根 package.json `0.2.0`、`public/README.md`；不是当前桌面主线或正式 P1 证据 |

统计函数会在 senderId 缺失时按 senderName 建桶，这只是现有统计口径；不得拿它推断气泡左右/跨联系人身份。当前类型/解析状态筛选仅针对已加载页，不能宣称全历史范围筛选或完整覆盖率。

## 3. 架构与持续保持的边界

- Main：`desktop/src/main.ts` 注册窄 IPC、SQLite/媒体/导出/采集服务，精确检查当前窗口主帧与本地 index.html；Preload：`desktop/src/preload.cjs` 只暴露 `desktopArchive`，类型在 `desktop/src/core/desktop-api.ts`。
- 数据：`desktop/src/core/archive-db.ts` 的账号/会话范围、持久 `messagePk` 和平台消息 ID；`desktop/src/adapters/douyin-history-adapter.ts` 是受门禁保护的真实历史适配器。UI 不直接操作 SQL、文件系统或供应商密钥。
- Renderer：原生 DOM/JS、本地 CSS，无新增前端框架。`desktop/src/renderer/renderer.js` 装配唯一控制器与管理事件；`desktop/src/renderer/chat-archive.js` 管理请求/选择/分页/引用；`desktop/src/renderer/message-view.js` 管理消息 DOM/媒体/筛选；视图与样式局部隔离。
- Shell：单一受信任入口 URL + 内存导航，持久 module root 切 hidden，不重建档案根；契约见 [P1B1-SHELL-CONTRACT.md](../P1B1-SHELL-CONTRACT.md)。该契约现含可选分析上下文，对应实现在未合并草稿 PR #1，见第 5 节。共享入口、IPC、schema、tokens 变更先由单一所有者固定，不能 A/B 并改。
- UI 冻结规则完整列于 [AGENTS.md](../AGENTS.md)：四个业务导航+底部设置、四分析标签、只读档案、单联系人 AI/固定来源/精确证据定位。设计目标不计入已实现能力。

## 4. 验收记录（历史执行，不是本轮重跑）

| 阶段/日期 | 集成完整 SHA | 自动化通过/失败/跳过 | Electron 与结论 |
| --- | --- | --- | --- |
| P1-a1 / 2026-10-10 | `e3a217f82cba7b419fd7ab4552c51ef3e4211c10` | 根 8/0/0；Desktop 161/0/0 | 阶段报告 PASS；入口/资源迁移 |
| P1-a2 / 2026-10-10 | `d6100f83dc052f7d726d09c701f4b1c7f661d764` | 根 8/0/0；Desktop 161/0/0 | 21/0/0，PASS；真实模块拆分回归 |
| P1-b1 / 2026-10-11 | `198355817d8bc71c3a6b887becde9942cdcd9a27` | 根 8/0/0；Desktop 166/0/0 | 24/0/0；原报告 PARTIAL（当时拖动未确认），后由用户确认标题栏拖动正常；原件未改 |
| P1-b2 / 2026-10-11 | `15d6d9243c69d54488c0b96f6e55c63b79dcc3e0` | 根 **8/0/0**；Desktop **168/0/0**；合计 **176/0/0** | 最终 **35/0/0**；历史阶段结论仍 **PARTIAL** |
| 最后一次竞态 / 2026-10-11 | 同上 P1-b2 SHA | 未重跑全套 | 原操作定向 **1/0/0**；`RACE_FINAL_CHECK: PASS`，历史原因仍 INCONCLUSIVE |

上述阶段根/Desktop 类型检查和 `build:dev` 均通过；正式 build 未获发布资格。不要把专项、复测及最终全套重复累计为“新增通过数”。本轮文档检查不替代新功能阶段的完整回归。

P1-b2 最终 35 项构成为历史阅读/媒体 21、Shell 3、真实身份/SQLite/IPC 7、布局操作 4。合成数据最终 3 账号/5 会话/**521 条消息**，3 份 PNG/WAV/MP4；运行 Electron **44.5.1**、内置 Node **24.21.0**、better-sqlite3 **13.0.3**、SQLite **3.53.4**。这是历史实测环境，不保证新克隆依赖/原生绑定已准备好。

### 必须保留的竞态备注

首次 21 项历史重放为 **20 通过/1 失败**：`pending real IPC page load invalidated by loaded quoted navigation` 在等待引用目标高亮时 **30000ms 超时**。随后三次原场景复测及确认 pending 的受控验收通过；这些结果没有解释首次失败。

最后一次原操作仅执行一次：同一 evaluate 中先分页再点引用，保留 350ms settle、30 秒等待、target-message/500 行/页码断言；增加只读时间戳/MutationObserver，未扣留该次 IPC 响应。高亮保留在同一节点，旧分页返回 5 行后未覆盖当前 500 行。

**当前无法复现；没有新的产品代码缺陷证据；首次原因仍不确定。** Main 时间轴只推断请求在途，未直接观察 Renderer Promise settlement 或内部 loadGeneration；诊断开销可能影响调度，未重建全套前序状态。保留 `RACE_DIAGNOSIS: INCONCLUSIVE` 和 P1-b2 PARTIAL，作为非阻断观察项继续，不能改成无保留 PASS，也不自动反复诊断刷成功。

### 视觉、安全与人工范围

本次基线真实截图验证暖白/暖棕、单 TitleBar/64px rail、独立滚动和最小窗口关键控件。当前屏幕 150% DPI；请求 980×650，实测外窗 981×651、Renderer 980×651，不冒称截图恰为 980×650。标题栏原生最小化/最大化/还原/关闭及双击在 P1-b1 实测，拖动由用户确认。

网络监测先于产品 Main 导入/首窗口，覆盖随后 Electron Session 的页面/媒体/reload，HTTP(S) 与 Renderer 异常为 0；不覆盖更早启动或非 Session Node/Playwright 网络，不能宣称整个进程绝对零请求。Main/Preload/SQLite 使用实际构建，隔离合成库和用户目录，安全配置未放宽。

仍待人工：音视频听感/音量/长时播放，字体和视觉偏好，长时间键鼠阅读，多屏及其他 DPI；真实保存对话框/最终 ZIP 文件。只在隔离合成档案中操作，不为了验收启用真实采集。

## 5. 已知风险与后续任务

| 编号/级别 | 证据与影响边界 | 后续处理 |
| --- | --- | --- |
| R1 / 观察项 | 首次分页/引用高亮超时未解释；后续均通过，尚无可复现新回归 | 保留原件与备注；出现新复现时记录 DOM/IPC/时序，定向修复，不主动无限复测 |
| R2 / MINOR，代码已处理、未合并 | 旧缺陷：`desktop/src/renderer/chat-archive.js` 的 `loadMessages` 在代次校验前写 `mediaSources`。草稿 PR #2 `f38df49b43628d28ab31e94190d0b1f1504cfc9d` 先记入本地映射，仅当前代次仍有效时才写入共享缓存，并补旧响应测试 | 待明早 Windows Electron / Integration 验收后，按 #1 → #3 → #2 合并。验收完成前不把本项记成已关闭的集成结论 |
| R3 / MINOR，代码已处理、未合并 | 旧缺陷：同文件 `handleContextEvent` 在档案隐藏时可能发起加载。草稿 PR #3 `a919946d9bae1e632748f3bf51a2798715cb930e` 在 `#chat-archive-page` 隐藏时不调用 `loadMessages`；同分支另把测试假计时器恢复为真实计时器 | 同上。返回档案时是否仍按既有路径初始化，留待 Integration 验收核对 |
| R4 / MINOR、能力缺口，最小契约已在草稿 PR #1、未合并 | 旧缺口：`desktop/src/renderer/shell/app-shell.js` 的 `navigateAppShell` 不传当前联系人。PR #1 `29a86de8f8fe220f553b6c59330e89a675163956` 已固定 `accountId + conversationId`。检索、模型、持久化、来源快照和证据抽屉仍未做 | 最小契约随 #1 先合；不以昵称替代稳定 ID。分析 UI 与模型不在本页授权范围内 |
| R5 / 正式发布阻断 | P1 证据与当前实现不匹配，正式门关闭 | 需另行授权的真实证据工作；离线测试/文档不能解决或绕过 |
| R6 / 环境限制 | Windows 缺 VS C++ 时 better-sqlite3 的 node-gyp 重编译可能失败 | 区分依赖环境与业务回归，先查锁文件/预构建/运行时兼容；系统工具需批准 |

**未合并栈（2026-10-12 登记，今晚不合并）：**建议合并顺序为草稿 PR **#1**（壳层分析上下文 / R4，`29a86de8f8fe220f553b6c59330e89a675163956`）→ **#3**（R3 档案隐藏不加载，`a919946d9bae1e632748f3bf51a2798715cb930e`）→ **#2**（R2 `mediaSources` 代次守卫，`f38df49b43628d28ab31e94190d0b1f1504cfc9d`）。三者均待明早 Windows 上的真实 Electron 与 Integration 验收。`p2GateOpen` 保持 `false`；正式 P1 不改为 PASS；采集门不开放。

**建议下一独立开发任务（未执行，需用户授权才开工）：**真实统计 DTO / 范围与指标口径。先确认统计只从已归档行生成、时间与会话范围如何界定、总览与互动各计哪些指标；数字和月份须由真实范围产生，不能硬编码设计样例，也不能把 `summarizeConversationStats` 的 senderName 回退当成可靠身份。没有本页授权就不自动开工。

后续路线（均未授权、未执行）：总览/互动展示 → 可追溯旅程 → AI 状态结构 → 经授权的检索/模型/持久化。主动发起、回复中位数的定义及模型/云端授权/历史保存方案仍须确认。没有本页授权就不自动开工。

## 6. 证据来源与可用性

协作文档建立时已读取下列原件；**它们仅本地可用，位于 Git 忽略的 artifacts 中，不随 GitHub 克隆交付**。新工作树不复制证据目录或数据库；缺少原件时只能引用本页登记的历史摘要，不能声称已现场复核。校验/迁移脱敏资料须逐项批准范围并保留来源哈希。

此节的 `<repo-root>` 表示保存历史验收资产的本地 UI 集成仓库根目录，不表示任意新克隆或文档工作树已有这些文件。下表路径均相对于该根（如 `<repo-root>/artifacts/p1-b2-integration/`），SHA256 为文档建立时登记值；本次修订保留这些值，未重新验收原件：

| 原件 | 可用性 | SHA256 |
| --- | --- | --- |
| `artifacts/p1-b2-integration/P1-B2-INTEGRATION-REPORT.md` | 已读，保留 PARTIAL | `bf787b8e3824e9d246af88a7eacf144b571e7e72fc38ae144db0ece3ea8ff8f9` |
| `artifacts/p1-b2-integration/electron-ui-results-attempt-1.json` | 首次失败保留 | `a2c6f594fd450b43bdcfe200554aee4b2e48f0deee7ee49932374770a2948b19` |
| `artifacts/p1-b2-integration/run-electron-acceptance-attempt-1.cjs` | 原操作脚本保留 | `2c4865ffaf4eb631909b1dbbda8e7300b813cfdbeec862c685b16328bc8f7f91` |
| `artifacts/p1-b2-race-final-20261011-01/RACE-FINAL-CHECK.md` | 已读，一次定向 PASS | `eb1b799b018f275128ead80a20c3f70070d1c7e114a8f83b7cc4ccd2198bb261` |
| `artifacts/p1-b2-race-final-20261011-01/evidence-manifest.json` | 最后诊断文件索引 | `914c6e8f2fcb71285384487a965ac22f1dce09b0c7b209324d2025d51853887c` |

P1-b2 同目录另有 `root-tests.json`、`desktop-tests.json`、最终 `electron-ui-results.json` / `shell-ui-results.json` / `identity-ui-results.json` / `layout-ui-results.json`、`race-diagnostic.json`、夹具/构建清单及网络记录；最后诊断目录含 DOM/IPC/Renderer 时间轴、`verification-summary.json` 和单次执行标记。上述详细文件本轮不重跑、不修改。

真实窗口 JPEG 在 `<repo-root>/artifacts/p1-b2-integration/`，原报告登记，文档建立时已核对存在性/哈希；仅本地可用：

| 文件 | 字节 | SHA256 |
| --- | ---: | --- |
| `screenshot-A2-normal-archive-native.jpg` | 92435 | `69672a5a3051e9aad1865a2e92a1c0cab1381c83130c63d0baf8770e180ba912` |
| `screenshot-B-media-reading-native.jpg` | 95859 | `7fec89f11c28b01f54e4b8a7a7ef7acf930de6a04f477ea0b35c86fda87740c1` |
| `screenshot-C-minimum-archive-native.jpg` | 72059 | `d2c00d0f2b88d65f364f28e615d1724e87afa2d1fd20c3cc4d41fb65f05b6cfe` |
| `screenshot-D-search-combination-native.jpg` | 69984 | `aefa413c65bc27ec3a5f42382cecf88c8e637eb9b1b694fd199f2245c09b61aa` |

更早报告位于同根 `artifacts/p1-a1-integration/`、`artifacts/p1-a2-integration/`、`artifacts/p1-b1-integration/`。P0 计划/证据来源清单仍是该根两份未跟踪文件；c566 原件及旧 Agent 工作树保留，不纳入本次提交。

设计来源为仓库外、仅本地可用的 `DouTrace-UI-Reference/` 资料目录，内有完整交接记录与最终 Stitch 包；部分文件名使用 URL 百分号编码，可解码名称定位 `DouTrace_UI设计分支_完整交接记录.md`。文档建立时读取交接决策，不重新设计或复制整个参考包。未持有资料的未来 Agent 应先向资料持有人确认目录位置与可用性；冻结规则已摘要到 AGENTS.md。

## 7. 更新记录规范

每次阶段集成完成后，由 **Integration Agent 更新本文件，Agent C 核对更新内容与实际验收证据**，包括提交 SHA、用例数量、证据可用性、门禁和未解决问题。核对结果应随阶段审查记录保存；证据缺失或结论不符时明确标注，不补造 PASS。更新请保留以下字段，新增证据明确属于哪个 SHA，不覆盖旧失败：

```text
日期/时区：
产品基线完整 SHA / 分支 / 本轮范围：
实现变化（已完成/部分/尚未实现）：
验证：命令、根/Desktop 通过/失败/跳过、build、Electron、人工：
证据：原件位置、可用性、SHA256、合成夹具、网络监测范围：
正式门状态 / 风险编号变化 / 未验事项：
下一任务、所有者、共享契约与必要授权：
替代哪条历史记录、为什么（不删除原件）：
```

### 2026-10-12 状态登记（不是阶段集成验收）

日期/时区：2026-10-12（Asia/Shanghai）。

产品基线完整 SHA / 分支 / 本轮范围：UI 产品基线仍为 `15d6d9243c69d54488c0b96f6e55c63b79dcc3e0`。本轮只修订 `docs/PROJECT_STATUS.md`，登记未合并栈顶 `f38df49b43628d28ab31e94190d0b1f1504cfc9d`。

实现变化（已完成/部分/尚未实现）：R4 最小上下文、R3 隐藏不加载、R2 `mediaSources` 代次守卫分别在草稿 PR #1 / #3 / #2，尚未合并。AI 检索/模型/持久化/证据抽屉与真实统计 UI 仍未实现。

验证：本轮未重跑 `npm run check`、`npm test`、desktop check/test、`build:dev` 或 Electron。各 PR 自身的测试不记为本页重跑。

证据：Git 提交 SHA 与草稿 PR 编号。没有新的 Electron 截图或验收原件。

正式门状态 / 风险编号变化 / 未验事项：`DEV_BASELINE_READY=YES`，`RELEASE_READY=NO`，正式 P1 仍 `inconclusive`，`implementationMatches=false`，`p2GateOpen=false`。R2/R3/R4 改为代码已处理、待验收合并。明早 Windows Electron / Integration 验收仍待做。今晚不合并。

下一任务、所有者、共享契约与必要授权：真实统计 DTO / 范围与指标口径。需用户授权才开工；没有本页授权就不自动开工。

替代哪条历史记录、为什么（不删除原件）：替代第 5 节原先的「本轮未修」，以及原先把「固定分析上下文」列为下一独立开发任务的段落。该上下文任务已进入 PR #1，不再作为下一开工项。P1-b2 PARTIAL 与竞态原件不改。
