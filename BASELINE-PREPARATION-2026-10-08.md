# 基线准备报告 — 2026-10-08

## 结论

**源码与本地验证通过，可供审阅；发布门未开放，当前不能标记为 release-ready。** 没有提交或推送代码，也没有使用真实抖音账号、聊天记录、Cookie 或媒体进行验证。

## 仓库规则与格式

- `.gitignore` 覆盖 `.desktop-data/` 回退数据目录、本地数据库/聊天导出、浏览器配置与 Cookie 文件、凭证文件和构建产物。`git check-ignore` 已确认数据库、`Cookies` 和 desktop 对应回退路径被忽略。
- `.gitattributes` 统一文本文件为 LF；desktop renderer 文件的换行格式已规范化。
- `git diff --check` 和 `git diff --cached --check` 均通过。

## 源码、测试和数据库

| 检查 | 结果 |
| --- | --- |
| 根目录 `npm test` | 5 个测试文件、8 项测试通过 |
| 根目录 `npm run check` | 通过 |
| 根目录 `npm run build` | 通过，生成未打包扩展目录 |
| `desktop/npm test` | 23 个测试文件、135 项测试通过 |
| `desktop/npm run check` | 通过 |
| SQLite 迁移测试 | 覆盖 v0、v3 到当前 schema v5 的迁移、重开与保留数据；对高于应用版本的 schema 拒绝启动 |

应用级数据仍按现有设计保存在当前 Windows 用户数据目录中；应用没有对归档数据库或浏览器配置文件增加静态加密。系统账户边界仍是本地数据保护边界。

## 隐私与安全修复

静态数据流审查发现，历史游标恢复会把缓存的请求模板和 protobuf 正文交给页面世界的 `fetch`；会话候选 ID 也可来自 URL 查询参数，且页面切换/源 frame 失效后存在继续使用旧上下文的路径。另有消息中的媒体候选 URL 可触发非抖音主机请求；浏览器 HTTP 客户端默认跟随重定向，允许主机校验本身不足以阻止跳转。

本次修复已加入工作区并纳入筛选暂存：

- 恢复请求改用受控的 Playwright 请求客户端，不再把请求头或正文暴露给页面 JavaScript；限制为精确的 HTTPS 历史接口和可信聊天页来源，不转发页面捕获的 Cookie 头，设置固定 Origin/Referer，并限制正文大小、请求取消和页面导航。Playwright context 请求仍可能按其 Cookie 存储和域规则自动附带匹配的会话 Cookie。
- 会话身份不再从 URL 查询参数推断；来源必须是同一浏览器上下文中的可信聊天页/frame。导航时清除捕获的请求、账户与会话状态，拒绝 detached frame 的旧模板。
- 媒体请求只接受 HTTPS、无凭证、默认端口且属于项目已有抖音媒体域名后缀的 URL；请求禁止重定向。
- 新增回归测试覆盖页面世界隔离、来源/导航校验、URL 身份、媒体域名白名单和重定向限制。

未执行真实账号的在线回放；抖音线上接口在当前登录态下的行为及媒体 CDN 的实时域名/重定向行为仍未实测。静态审查不是对所有辅助 CLI、研究材料和项目文档的穷尽审计。安全审查期间候选复核指出的重定向问题已修复并加入测试。

## Electron 与打包数据库兼容性

- 在隔离临时输出目录用 Electron Builder 26.15.3 / Electron 44.5.1 生成 Windows x64 portable smoke 包成功。打包器提示缺少作者元数据、默认图标和重复 `heic-decode` 引用；这些提示未阻止生成。
- 确认 `better-sqlite3` 的 `win32-x64` 原生模块进入 `app.asar.unpacked`。
- 用隔离的 `LOCALAPPDATA` 和合成数据库启动打包应用；确认包内产品页面加载、受限 preload bridge 可用、`window.require` 与 `window.process` 未暴露。IPC 返回合成会话和消息，采集保持禁用并显示 `p1-required`。只读 SQLite 检查结果为 `user_version=5`、`integrity_check=ok`。没有打开抖音或导入个人数据。
- 用户在 smoke 期间报告卡巴斯基阻止程序。应用已停止，未关闭安全防护、添加例外或绕过拦截；没有获取告警详情，因此无法判断具体检测原因。
- **发布验证仍失败关闭。** `desktop/npm run build` 的 TypeScript 编译和静态文件复制完成，但 release-validation 因 P1 汇总为 `inconclusive`、`implementationMatches=false` 且 `p2GateOpen=false` 而拒绝通过。已有真实证据与当前实现散列不匹配；portable smoke 包不绕过也不替代此门槛。需针对当前实现重新完成完整 P1 真实验证，之后才能获得发布资格。

## 暂存与保留范围

- 保留任务开始前已暂存的 39 个路径，不重置或改写其用户变更。
- 本次筛选并暂存 `.gitignore` / `.gitattributes` / 本报告，以及历史传输、页面状态、会话、adapter、媒体 URL 校验、主进程和相应回归测试中的本次改动；同时保留已在暂存区的 desktop 产品文件。
- 其他已有工作区修改和未跟踪的 P2–P5 计划文档保持未暂存。收尾核查确认暂存区共 48 个路径：保留原有 39 个已暂存路径和此前的 2 个基线文件，本次再加入 7 个安全修复相关路径。
- 没有创建提交，也没有推送代码。
