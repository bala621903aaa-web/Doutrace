# 抖忆 · DouTrace

面向 Windows 的本地聊天档案项目，桌面主线使用 Electron、TypeScript 和 SQLite / better-sqlite3。当前 UI V1 提供只读聊天阅读体验；真实抖音采集与正式发布仍受关闭的 P1 门禁保护。

产品基线：`15d6d9243c69d54488c0b96f6e55c63b79dcc3e0`。文档核对日期：2026-10-12。详细进度、证据和后续工作见 [PROJECT_STATUS.md](docs/PROJECT_STATUS.md)，AI 协作先读 [AGENTS.md](AGENTS.md)。

## 当前可以做什么

- 阅读已有本机归档：按账号/会话隔离，搜索正文/发送者，每页 500 条；类型与解析状态组合筛选当前加载页，清除筛选、查看计数和空结果。
- 查看引用并定位高亮，包括跨页查找和筛选冲突处理；搜索使用 220ms 防抖，并有旧请求失效保护。
- 阅读本地图片、播放受支持的音视频。筛选保留持续可见媒体节点，隐藏时暂停，清除筛选不自行播放；离开档案清理媒体。
- 使用统一 Windows TitleBar、64px 导航和暖白/暖棕档案布局；档案只读，没有发送消息输入栏。
- 使用已有 ZIP 导出路径与档案工具入口。导出报告区分历史范围、内容和附件完整度；部分档案不能称作全量历史。
- 开发者可复用聊天统计纯函数：发送者/类型计数、上海时区归日和异常数据处理，不读取正文；分析页面还未接入该模块。

## 当前还没有完成什么

聊天分析的总览、互动分析、聊天旅程和 AI 洞察目前只有标签与诚实空状态；没有真实统计仪表盘、AI 模型/检索/历史、证据抽屉或“分析此会话”上下文传递。独立媒体管理、火花提醒和设置页也仍是占位入口。

采集、游标恢复、补修、附件重试已有源码与自动化，但**当前版本不具备获准使用的真实抖音自动采集能力**。开发模式禁用真实连接/采集/在线补修与联网自动化；正式 P1 为 `inconclusive`、实现版本不匹配、`p2GateOpen=false`，`RELEASE_READY=NO`。GitHub 默认分支和离线 UI 通过不意味着正式发布就绪，不应移除保护来尝试真实账号。

## 验收边界

该产品基线的历史自动化为根目录 **8/8**、Desktop **168/168**（合计 **176 通过、0 失败、0 跳过**），类型检查与 `build:dev` 通过；最终真实 Electron 离线检查 **35/35**，使用真实 Main/Preload/SQLite 和隔离合成数据。本轮文档工作未重复运行这些测试。

**P1-b2 历史结论仍为 PARTIAL。**首次分页/引用竞态曾出现一次 30 秒高亮等待超时，原因仍不确定。后续受控验收及最后一次保留原操作/超时的定向重放通过（`RACE_FINAL_CHECK: PASS`）；没有新的产品缺陷证据，但不能据此擦除首次失败或将历史诊断 `INCONCLUSIVE` 改成已解决。可保留此非阻断观察项继续开发。

原生窗控及双击已实测，标题栏拖动由用户确认。实际听感、长时阅读、多 DPI/多屏以及系统保存对话框/最终 ZIP 的该轮人工验收仍需补充。证据是本地忽略资产，不随克隆交付；来源、SHA256 与覆盖限制见 [项目状态](docs/PROJECT_STATUS.md)。

## 开发与离线验证

桌面子项目版本 `0.3.0`，根目录保留 `0.2.0` Manifest V3 扩展原型。两套依赖/构建目录分开；根目录 `npm run build` 构建的是扩展，不是 Electron。

在独立工作树中核对分支、HEAD 和状态后，按根目录及 `desktop/` 各自的 package-lock.json 准备依赖（各自执行 `npm ci`，不要更新锁文件）。历史实测环境为 Electron 44.5.1 / 内置 Node 24.21.0 / better-sqlite3 13.0.3；新环境须另核验。

Windows 若因缺 Visual Studio C++ 工具链导致 better-sqlite3 重编译失败，先诊断包内预构建、Node-API/运行时及锁文件，不自动安装系统工具。`npm ci --ignore-scripts` 不证明 Electron 可执行文件和原生 SQLite 可用。

依赖可用后，在仓库根目录执行：

```powershell
npm run check
npm test
npm --prefix desktop run check
npm --prefix desktop test
npm --prefix desktop run build:dev
git diff --check
```

本地模拟开发窗口（会创建本工作树开发数据目录）：

```powershell
npm --prefix desktop run dev
```

`dev` 会先运行 `build:dev`，再启动 Electron；它不会自动提供历史验收的 521 条合成档案。没有种子时可以看到空档案，不应连接真实账号补数据。开发数据位于 `desktop/.desktop-data/mock-dev/`，构建位于 `desktop/dist/`。

正式离线验收应另建合成 SQLite/本地媒体与隔离 userData、APPDATA、LOCALAPPDATA、TEMP，先核对脚本路径和夹具来源。普通开发启动不等于完整用户目录隔离或 35 项验收；不要运行指向旧树的脚本覆盖历史证据，也不要复制真实数据库/Cookie/浏览器配置。

桌面正式 `build` / `package` 仍经过 P1 发布验证，当前预期在 `release-validation-p1-gate-closed` 失败关闭。UI 开发使用 `build:dev`，不能伪造验证文件、修改门禁/断言或运行此前被杀毒拦截的 portable。遇安全软件报警停止并记录，不关闭防护或添加例外。

## 仓库导览

| 路径 | 内容 |
| --- | --- |
| `desktop/src/main.ts` / `preload.cjs` | Electron Main、受限 IPC 和 preload 桥 |
| `desktop/src/core/` | SQLite、采集/补修/导出、附件、纯统计及发布校验 |
| `desktop/src/adapters/` / `probe/` | 真实历史适配与 P1 证据设施；非普通离线开发入口 |
| `desktop/src/renderer/` | 原生 DOM 模块、本地 CSS/SVG、Shell 与聊天档案 |
| `desktop/tests/` | 桌面测试；Renderer 测试加载真实磁盘构建 HTML/JS/CSS |
| `src/` / `public/` / `tests/` | 旧扩展原型及测试，与桌面项目分离 |

- [AGENTS.md](AGENTS.md)：四 Agent 分工、Worktree/Git、安全约束与冻结 UI。
- [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md)：当前状态、已知风险、验收原件索引和更新模板。
- [PRODUCT.md](PRODUCT.md)：产品目的与范围；设计方向不等于当前能力验收。
- [P1B1-SHELL-CONTRACT.md](P1B1-SHELL-CONTRACT.md)：当前 Shell/档案文件边界。
- [desktop/P1-ACCEPTANCE-SUMMARY.md](desktop/P1-ACCEPTANCE-SUMMARY.md)：当前正式门状态。
- [HANDOFF.md](HANDOFF.md) / [desktop/README.md](desktop/README.md)：保留的历史交接/技术资料，旧 PASS 和命令须对照当前源码/门状态。

协作只在独立任务分支与 Worktree 进行；不未经授权改默认/长期分支、不自动推送。真实账号、第三方聊天隐私与模型云端传输须另行明确授权。尚未实现的功能保持明确不可用状态。
