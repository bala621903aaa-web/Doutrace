# DouTrace AI 协作规则

适用于整个仓库。开始任务时同时读取任务范围内更深层的 `AGENTS.md`（如有）。用户本轮明确授权决定任务范围；本文件不授权自动开发、联网采集、发布或启动其他 Agent。

## 先确认事实与任务范围

- 当前 UI 产品基线：`15d6d9243c69d54488c0b96f6e55c63b79dcc3e0`。这不是要求所有未来任务回到旧提交；每轮先记录实际路径、分支、完整 HEAD、`git status --short`、`git worktree list` 和与批准基线的祖先关系。
- 阅读 [项目状态](docs/PROJECT_STATUS.md)、[产品说明](PRODUCT.md)、[Shell 契约](P1B1-SHELL-CONTRACT.md)、任务涉及的真实源码/测试及验收记录。`HANDOFF.md` 和 `desktop/README.md` 含旧快照，与当前门禁不一致时不能采用旧 PASS 开门。
- 区分“源码存在”“自动化通过”“真实 Electron 验收”“人工确认”“正式发布资格”。设计样例、旧测试数量、默认分支名称均不能证明当前功能或发布就绪。
- 本项目已有 Electron/SQLite/Renderer 和 Worktree 流程，不重新初始化，不从零搭建。每轮只做批准阶段，禁止顺带重构、升级依赖、引入框架或启动下一阶段。

## 四 Agent 分工与文件所有权

| 角色 | 职责与默认边界 |
| --- | --- |
| Agent A：开发 | 核心数据、统计/服务、必要 schema 迁移，或明确指派的 Shell/构建基础任务；拥有本次任务声明的实现与专项测试 |
| Agent B：开发 | 基于冻结契约开发页面、交互与局部样式；不自行修改数据库、共享 IPC、锁文件、发布门或另一 Agent 的控制器 |
| Agent C：独立 Reviewer | 只读审查真实 Git diff、完整 SHA、契约、测试与证据；给出 PASS / CONDITIONAL_PASS / FAIL 和阻断项，不在审查中替开发者修代码 |
| Integration Agent | 核对基线与工作树，冻结文件边界/共享契约，合并受审提交，在集成 HEAD 验证并记录证据；问题退回所有者定向修复及复审，不降低断言取得 PASS |

以上是任务分配规则，不表示这些后续功能已实现。每次开发派发必须附基线 SHA、文件清单、接口约定、验收标准与禁止范围。没有用户授权，不自动创建/派发 Agent 任务。

- A、B 各用从批准提交创建的独立分支和 Worktree，C 不改开发工作树，Integration 使用独立集成树。不得借用原始项目或另一个 Agent 的脏工作区。
- 可以并行：共享 DTO/身份/时间口径先冻结，A 做数据实现，B 在独立页面文件中消费契约；B 的 mock 不可冒充真实服务验收。先合 A/服务契约，再合 B，最后验证真实链路。
- 必须串行：双方都要修改 `renderer.js`、`index.html`、`shell/app-shell.js`、`styles/tokens.css`、`archive-db.ts`、`desktop-api.ts`、`preload.cjs`、`main.ts` 或公共测试夹具。先做单所有者的小契约任务、审查和集成，再开放下游；不强求同时开发。
- 现有页面边界以 `P1B1-SHELL-CONTRACT.md` 为准：Shell 拥有全局根/导航/tokens；档案视图是 `chat-archive-view.js` + `styles/archive.css`；业务行为在 `chat-archive.js` 和 `message-view.js`。跨边界修改需先明确任务所有者，不通过大面积格式化制造冲突。

## Git 与资产保护

- 默认分支及 `master`、`codex/dev-baseline-p2-p5`、历史集成/开发树的保护是**项目流程约束**，不代表 GitHub 已启用技术分支保护。当前 GitHub 默认分支 `protected=false`（本轮用户确认）。仍只在任务分支修改，未经明确授权不切换或改写其他工作树、不合入默认分支、不 push/发布。
- 目标分支/路径已存在、HEAD 不符、有来源不明修改或冲突时停止相关写操作并报告；不得自行 reset、stash、clean、强制覆盖、删除分支/Worktree 或移动用户文件。
- 保留未跟踪 `UI_INTEGRATION_PLAN.md`、`UI_ACCEPTANCE_EVIDENCE_SOURCES.md` 及历史 artifacts。只精确暂存本次允许的文件，不使用 `git add .` 捎带资料/数据。
- 集成须有用户授权及 C 对确切 SHA 的审查结论；普通 merge（需要清晰集成历史时 `--no-ff`），不 squash/rebase/强推。核对合并父提交、受审 SHA 祖先关系、变更范围和最终状态。
- 验收输出使用新的隔离 artifacts 子目录，记录 HEAD、脚本/夹具来源及 SHA256；不覆盖失败证据，不把旧树的截图当作新 HEAD 结果。不复制整个 artifacts、node_modules、dist 或未知数据到新树。

## 安全与真实数据边界

- 正式 P1 当前为 `inconclusive`、`implementationMatches=false`、`p2GateOpen=false`，发布门保持 fail-closed。`DEV_BASELINE_READY=YES` 仅表示可继续离线开发；`RELEASE_READY=NO`。UI 的 P2 规划不等于正式采集 P2 门开放。
- 保留 `build-release-validation.mjs`、`core/release-validation.ts` 和负向测试的真实校验；不得改 P1–P5 结果、复活失效证据、伪造 metadata、删 development marker 或绕门使正式 build 成功。
- 默认使用合成数据和离线测试。真实账号登录、采集或验证需另行明确授权，并满足既有门禁；不得自动发送抖音消息、抓取凭据，或读取/复制真实聊天数据库、Cookie、日常浏览器配置。日志/提交/公开文档不带真实正文、媒体 URL、认证材料或原始用户标识。
- Electron 保持 `sandbox=true`、`contextIsolation=true`、`nodeIntegration=false`；Main 校验当前窗口主帧和精确本地入口 URL；不增加任意 IPC/SQL/文件访问或通用窗口控制桥，不为路由放宽可信 URL。
- 开发构建的连接、采集、在线补修/附件重试禁用必须继续有效；只做离线入口和拒绝路径验证时不可报告在线流程成功。
- 遇安全软件报警立即停止启动并记录；不关闭卡巴斯基、不添加例外、不运行此前被拦 portable。安装系统工具/修改系统配置须另行获批。

## UI 已冻结的产品决策

- 全应用只有一个全宽 Windows TitleBar：左侧 Logo +「抖忆 · DouTrace」，右侧系统窗控。下方唯一 **64px** 图标导航，顺序为聊天档案、聊天分析、媒体资源、火花提醒，设置固定底部；Logo 不占 rail，不增独立首页、AI、导出导航。
- 聊天分析固定四标签：总览、互动分析、聊天旅程、AI 洞察。目前均为诚实空状态；不得展示 Stitch 示例统计或 AI 回答作为真实结果。
- 聊天档案只读，无发送输入栏；保留会话隔离、搜索/筛选、分页、引用和媒体阅读。暖白/暖棕视觉沿用本地 tokens，不重开已定稿设计。
- 总览目标为三项指标（消息数/活跃天数/双方占比）、一张双方热度折线图和短发现；互动分析目标为双方主动发起/回复中位数、14 个月分组柱状图和一组回复分布。数字与月份由真实范围产生，指标口径须先确认，不能硬编码设计样例。
- 聊天旅程是内容区内部滚动的双栏时间轴，每节点可追溯归档消息；不能由聊天量直接断言关系阶段。
- AI MVP 每次只分析一位联系人；历史按联系人隔离。通用分析/交流风格/关系变化/共同回忆是模式选择器，不是四页或四套 Agent。
- 每个 AI 回答固定生成时的联系人、范围、归档数据量、来源版本及引用集合，不随之后全局筛选改变；以自然语言和原始引用为主，不重复统计仪表盘。
- 引用打开右侧证据抽屉，抽屉默认收起 AI 历史栏、rail 保持可见，不加第二套导航或黑遮罩；凭持久消息身份精确定位原文，不用模型文本模糊搜索替代。模型/云传输、授权、密钥与历史保存方案尚待确定，默认不发送聊天数据。
- “分析此会话”目标契约是 `accountId + conversationId → 聊天分析 → AI 洞察`，**当前尚未接入**。先独立固定上下文契约，再实现按钮，不在视觉集成中顺带接 AI。
- Stitch 只是参考：最终确认决策高于早期 HTML/规范；`ai_1/screen.png` 无效，`_2` 重复标题栏须去重；不用 Tailwind CDN、Google Fonts 或整页 HTML 覆盖现有 Renderer。资源/字体/图标保持本地及许可可追溯。

## 业务行为与测试要求

- 归档键是 `accountId + conversationId`，消息有持久 `messagePk` 与平台 ID；昵称只展示，不用于气泡身份、联系人隔离或 AI 历史键。缺少可靠 senderId 时采用中性布局。
- 保持搜索 **220ms** 防抖、每页 **500** 条、导航/选择时取消 debounce 和旧请求失效；引用可解除冲突筛选并定位/高亮。类型/状态筛选作用于当前加载消息，计数不可宣称全历史统计。
- 仅筛选时用 `row.hidden` 保留持续可见媒体节点；隐藏音视频暂停，清除不自动播放；分页/切会话/离页停止旧媒体，离页失效请求。文本、昵称、引用与属性内容须安全转义。
- `summarizeConversationStats` 只统计传入行，不读正文/推断历史完整性；现有 senderName 回退仅是统计桶，不能复用作可靠身份判断。

业务阶段集成运行并报告实际通过/失败/跳过数量，专项已在全套中则不重复计数：

```powershell
npm run check
npm test
npm --prefix desktop run check
npm --prefix desktop test
npm --prefix desktop run build:dev
git diff --check
git status --short
```

- 保持 `app-shell`、`renderer-message-filter`、`renderer-retry`、`conversation-stats`、DB/导出/补修/采集/媒体、协议/时间、`desktop-api-contract`、`renderer-trust`、`build-mode`、`release-validation`、`p1-*` 等现有测试有效；不删断言、延长超时、跳过失败或关闭安全检查获取 PASS。
- Renderer 测试使用 `desktop/tests/renderer-test-dom.ts` 经 `buildRenderer` 写入磁盘的 HTML/JS/CSS，执行与交付一致的入口；确认本地 SVG/样式实际加载，不只测试内存 bundle。
- 资源/行为变更须在集成 HEAD 验证真实 Main + Preload + SQLite，使用新合成库、本地媒体及隔离 userData/APPDATA/LOCALAPPDATA/TEMP。不要直接运行指向旧树的历史脚本。记录网络监测注册时机与范围，不声称覆盖未监测的整个进程。
- 截图必须来自该 HEAD 的真实 Electron 窗口，保存文件/大小/哈希；980×650、媒体节点/暂停及引用竞态要实测。听感、多 DPI/多屏和无法操控的 OS 交互列人工待验，不用 JSDOM 替代。
- 依赖按两份锁文件准备；缺 VS C++ 或原生 SQLite 不兼容先诊断，不自动装系统工具，不把 `--ignore-scripts` 安装成功等同原生模块验收。
- **纯文档修改**核对源码/证据、Markdown 本地链接、文档一致性、允许路径、`git diff --check` 与 Git 状态即可；不为文档重复运行全套/Electron，不把历史测试称本轮重跑。

## 验收诚实性与状态维护

P1-b2 仍为历史 **PARTIAL**：首次引用/分页竞态 30 秒高亮超时原因未明；后续受控验收和最后一次原操作定向复测通过，`RACE_FINAL_CHECK=PASS`，历史 `RACE_DIAGNOSIS=INCONCLUSIVE`。没有新缺陷证据，可保留备注继续；不能据此改写旧结论或自动重复刷 PASS。

每次阶段集成完成后，由 **Integration Agent 更新 `docs/PROJECT_STATUS.md`，Agent C 核对更新内容与实际验收证据**。更新须附日期、完整 SHA、范围、用例数量、证据位置/可用性、门禁、已知问题和人工待验。新增记录/明确替代关系，保留失败原件与历史不确定性。资料缺失时说明缺失，不凭旧记忆补造 PASS。
