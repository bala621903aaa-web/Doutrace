# 桌面私聊档案架构复核（2026-10-08）

## 结论

当前主线是桌面版 `0.3.0`：Electron 负责本机界面与进程协调，独立 Chrome/Edge 承载用户登录，已通过 P1 的 IM 历史协议适配器读取单人私聊，SQLite 保存档案，再生成离线 ZIP。这个方向与[产品说明](../PRODUCT.md)一致。根目录 `src/` 与 `public/` 的 `0.2.0` 扩展属于独立旧原型，不能把它的页内控制体验或 DOM 采集能力当成桌面版的实现状态。

```mermaid
flowchart LR
  B[独立 Chrome / Edge 登录态] --> A[已验证 IM 历史适配器]
  A --> N[消息解释与资源描述]
  N --> C[串行采集器]
  C --> D[SQLite: 消息、附件描述、游标同页提交]
  D --> Q[可恢复附件队列]
  Q --> F[本机媒体文件]
  D --> X[档案查询 / ZIP 快照]
  F --> X
  X --> M[Electron 主进程]
  M --> P[受限 preload / IPC]
  P --> U[桌面界面]
```

## 边界与判断

| 边界 | 现状 | 判断 |
| --- | --- | --- |
| 平台读取 | `adapters/douyin-history-adapter.ts` 复用 P1 已验证的无滚动历史读取，账号、会话和平台 ID 在提交前核对 | 保留，不改走 DOM 滚动或扩展原型 |
| 持久化 | `core/collector.ts` 串行读页，`core/archive-db.ts` 在同一事务写消息、附件描述与游标；附件文件独立队列处理 | 分层合理，文本可先保存，附件失败可恢复 |
| 补修 | `core/archive-repair.ts` 只更新已存消息，使用独立进度，不移动正式采集游标 | 符合旧档案恢复目标；本次补上档案变化后的进度失效判断 |
| 导出 | `core/archive-export.ts` 按公开字段生成 ZIP，历史范围、内容和必要附件分别判定完整性 | 表述诚实；导出范围以最后已提交的检查点为准 |
| 桌面权限 | `main.ts` 与 `preload.cjs` 提供有限 API；媒体文件路径只由主进程解析 | 本次增加主窗口导航和所有 IPC 调用来源约束 |
| 发布门 | 构建时重新汇总 P1 八项证据并绑定构建文件散列；失效时只开放离线功能 | 当前 P1 汇总为 `inconclusive`、实现不匹配、P2 门关闭；标准 build 在发布门失败关闭 |

## 本次已纠正

1. `startRun()` 现在只登记运行。旧游标会保持到新页面实际提交；首次请求失败或进程中断不会抹掉最后一个已提交的续传点。
2. 服务端明确 `hasMore=false` 时，运行完成状态与页面、游标在同一 SQLite 事务写入。重启恢复不会把已提交的历史终点误标为中断。导出根据检查点所属运行判断历史范围，忽略之后零页失败运行的干扰。
3. 补修进度仅在消息集、正式检查点和运行记录均未变化时续用；正式采集新增不完整消息后会重新建立补修目标。
4. 附件“重试”按钮改用实际存在的 `mediaSources` 缓存，点击能进入重试 API。新增界面行为测试。
5. 所有档案 IPC 调用仅接受当前桌面主窗口的主帧与固定本地页面；禁止主窗口自行跳转和打开新窗口。新增来源边界测试。
6. [产品说明](../PRODUCT.md) 以当前桌面版为主线，明确旧扩展的独立地位，消除“必须在聊天页内控制采集”与桌面版实际流程的冲突。

## 安全与请求边界

- 历史请求回放仅接受可信抖音聊天页主帧捕获的精确历史接口模板，不再把请求头或正文交给页面 JavaScript 执行；按页面/frame 代次隔离，导航会清除模板并使在途请求失效。回放使用 Playwright `BrowserContext.request.post()`、固定可信 `Origin`/`Referer`、精简头部和 `maxRedirects: 0`，不会手动转发捕获的 Cookie 头。Playwright context 仍可能依据自身 Cookie 存储与域规则自动附带匹配的 Cookie；未使用真实账号在线验证。
- 媒体地址要求 HTTPS、无凭据、默认/443 端口，并匹配 `douyin.com`、`douyinvod.com`、`douyinpic.com` 或 `iesdouyin.com` 主机后缀；附件请求禁止重定向。真实 CDN 主机和重定向行为尚未实测，来源策略可能需要基于真实脱敏样本调整。

## 剩余边界

- **交付验证：** 2026-10-06 的 portable 和 ZIP 是本次修正前的候选。当前根目录检查通过（5 个文件、8 项），桌面 `check` 通过，桌面测试为 23 个文件、135 项。标准桌面 `build` 在 TypeScript 编译、静态资源复制之后，于 `release-validation-p1-gate-closed` 失败关闭；P1 汇总为 `inconclusive`，实现散列不匹配，P2 门关闭。单独使用 Electron Builder 生成隔离的 Windows x64 portable smoke 包后，包内 `better-sqlite3` 在 Electron 44.5.1 中通过合成数据启动和 schema v5 `integrity_check=ok` 验证；产品旧库读取、离线 HTML 搜索/引用/图片/语音仍待复核。该 smoke 包不绕过也不替代发布门。
- **大档案内存：** 导出当前一次读取整个会话并用 `zipSync` 在内存组包；附件下载也通过 Playwright `response.body()` 一次取回。已有档案记录未显示此问题，但更大的媒体档案可能占用大量内存。扩大支持范围前应改为有界下载与流式 ZIP，并做规模验证。
- **产品路线：** 桌面版要求用户在独立浏览器和应用窗口间切换；若下一阶段的首要目标重新变成“在抖音聊天页内完成全部操作”，应把旧扩展作为独立产品线重新立项，不应把两套采集链路混合。

## 本次验证

- 根目录 `npm run check` 与 `npm test`：通过；5 个文件、8 项。
- `npm --prefix desktop run check`：通过。
- `npm --prefix desktop test`：23 个文件、135 项通过。
- `npm --prefix desktop run build`：TypeScript 编译与静态资源复制通过，随后在 `release-validation-p1-gate-closed` 失败；P1 当前汇总状态为 `inconclusive`，`implementationMatches=false`、`p2GateOpen=false`。
- 直接调用 Electron Builder 在隔离临时目录生成 Windows x64 portable smoke 包成功（Electron Builder 26.15.3 / Electron 44.5.1）；better-sqlite3 x64 原生预构建文件存在。此操作只用于 smoke，不是正式发布构建。
- 合成数据启动检查：包内产品页面加载、窄 preload bridge 可用，`window.require`/`window.process` 未暴露；IPC 返回合成会话与消息，采集保持禁用且显示 `p1-required`。隔离数据库 `user_version=5`、`integrity_check=ok`。
- 用户报告卡巴斯基在 smoke 期间阻止了程序。已停止 smoke 应用，没有关闭保护、添加例外或尝试绕过；未取得精确告警内容，故不能判断产品的具体检测原因。
- 未运行新的真实抖音采集、当前产品 portable 的旧档案读取或离线浏览器人工交互。
