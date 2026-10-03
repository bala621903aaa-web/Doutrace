# P1 GitHub 参考项目调查与接续方案

**后续状态（2026-10-04）：这些项目的协议线索已用于当前实现，Sol 已完成八项真实 P1，版本匹配、P2 门开放。** 最新结果见 [验收汇总](P1-ACCEPTANCE-SUMMARY.md) 和 [复检记录](P1-SOL-RECHECK.md)。以下是 2026-10-03 的源码调查记录，其“P1 仍未通过”描述为当时状态。

调查日期：2026-10-03（Asia/Shanghai）。

## 当前结论

三个参考项目给出了可复核的协议线索，原先“只有字段号，没有候选映射”的障碍已经取得进展。旧真实报告的历史请求、响应及所保留的一条消息形状均能与候选结构匹配。

**P1 仍未通过。** 本轮完成源码调查、旧报告结构对照和只读探针增强，没有完成新的真实历史读取。当前可用浏览器的标签列表为空；旧报告没有保存原始请求/响应，因此无法从旧文件恢复消息值或直接重放三页。

## 可复核来源

以下提交均在调查时通过 GitHub API/CLI 核对并固定；下载的第三方源码只保存在系统临时目录，没有运行第三方采集器。

| 项目 | 固定提交 | 对本任务的用途 |
|---|---|---|
| [TeamBreakerr/douyin-chat-export](https://github.com/TeamBreakerr/douyin-chat-export/tree/2b3ed23ac47884069619f53a2c68350e093ac86c) | `2b3ed23ac47884069619f53a2c68350e093ac86c` | 网页端请求、分页和引用字段候选 |
| [my-jxy/douyin-im-export](https://github.com/my-jxy/douyin-im-export/tree/f99838e3a0fcc2d0b08075c7452dd63ace998f52) | `f99838e3a0fcc2d0b08075c7452dd63ace998f52` | 独立编解码实现，用于交叉检查包裹层和分页字段 |
| [lukylong/DyAuthReply](https://github.com/lukylong/DyAuthReply/tree/bdc89fabbf904beb86c6ee6ccc8e8a454e1e4681) | `bdc89fabbf904beb86c6ee6ccc8e8a454e1e4681` | 创作者中心接口职责、接收字段和协议误差检查 |
| [lukylong/DouYin_Spider](https://github.com/lukylong/DouYin_Spider/tree/4479ea784bf3e63e75fcbe4ca985f84678d46b27) | `4479ea784bf3e63e75fcbe4ca985f84678d46b27` | DyAuthReply 所引用的上游 `.proto`，补充核对消息前八字段 |

### 1. 网页端历史接口确实有对应实现

[TeamBreakerr 的 web_scraper.py](https://github.com/TeamBreakerr/douyin-chat-export/blob/2b3ed23ac47884069619f53a2c68350e093ac86c/extractor/web_scraper.py#L1138) 使用 `get_by_conversation` 读取历史，并明确说明请求内层第 3 字段是每会话固定的 `conversation_short_id`，旧命名 `cursor` 有误。其请求包裹层为 `8 → 301`，响应为 `6 → 301`；响应内层第 1 字段重复承载消息，第 2 字段续传，第 3 字段表示 `hasMore`。

[my-jxy 的 fetch_douyin_im.py](https://github.com/my-jxy/douyin-im-export/blob/f99838e3a0fcc2d0b08075c7452dd63ace998f52/fetch_douyin_im.py#L75) 给出相同包裹层和字段位置，也保持内层第 3 字段不变、更新第 5 字段。它沿用 `cursor`/`timestamp` 命名，但这不能证明续传值就是日历时间。它还硬编码序列号起点和浏览器指纹；本项目没有采纳这些常数。

### 2. 用户提供的发送分析文档不是历史分页 schema

[IM_SEND_PROTOCOL_ANALYSIS.md](https://github.com/lukylong/DyAuthReply/blob/bdc89fabbf904beb86c6ee6ccc8e8a454e1e4681/backend-django/core/douyin/IM_SEND_PROTOCOL_ANALYSIS.md) 主要说明发送、已读和读索引接口职责，不能单独解决 P1。顺着该仓库读到的 [im_protocol_recv.py](https://github.com/lukylong/DyAuthReply/blob/bdc89fabbf904beb86c6ee6ccc8e8a454e1e4681/backend-django/core/douyin/runtime/transport/wire/im_protocol_recv.py) 才包含接收编解码。

该接收实现对部分字段的解释与网页导出器冲突：消息第 2/6 字段的类型名称相反，第 4 字段被命名为微秒时间，请求第 3 字段被当作 `since_message_id`。这些解释不能直接移植到 `www.douyin.com/chat`。

### 3. 排序值与发送时间必须分开

[上游 Response.proto](https://github.com/lukylong/DouYin_Spider/blob/4479ea784bf3e63e75fcbe4ca985f84678d46b27/static/Response.proto#L25) 明确把消息第 4 字段命名为 `index_in_conversation`，第 2 字段为 `conversation_type`，第 6 字段为 `message_type`。据此，应优先采用索引和消息类型的解释进行校准。

这份上游 schema 并不完整：消息只列到第 8 字段，也没有历史分页体；顶层第 3 字段甚至被声明为字符串，而本地真实报告记录的是 VARINT。因此不能将它标为抖音官方完整协议或据此宣布时间语义已验证。

## 候选字段对照

`fN` 表示字段号，括号内为线类型。以下是调查候选，真实字段值尚待新探针核对。

| 位置 | 候选解释 | 本地旧报告证据 | 校准要求 |
|---|---|---|---|
| 请求 `f8.f301.f1`（LEN） | 会话 ID | 存在 | 与选定会话、消息中的会话 ID 对账 |
| 请求 `f8.f301.f3`（VARINT） | 固定会话短 ID | 19 位 | 与消息 `f5` 相等，三页保持固定 |
| 请求 `f8.f301.f5`（VARINT） | 历史续传值 | 16 位 | 下一页采用上一页返回值；不假定时间单位 |
| 请求 `f8.f301.f6`（VARINT） | 条数上限 | 2 位 | 实测请求值及消息数；报告不保存原值 |
| 响应 `f6.f301.f1`（LEN，重复） | 消息集合 | 50 项 | 必须检查每条，不只检查最后一条 |
| 响应 `f6.f301.f2`（VARINT） | 下一历史游标 | 16 位 | 验证可推进、可继续恢复 |
| 响应 `f6.f301.f3`（VARINT） | `has_more` 候选 | 1 位 | 明确 0/1；缺失时保留未知 |
| 消息 `f3`（VARINT） | 服务端消息 ID | 19 位 | 始终用 BigInt/十进制字符串，验证唯一性 |
| 消息 `f4`（VARINT） | 会话排序索引 | 16 位 | 不直接除以 1000 当作发送时间 |
| 消息 `f5`（VARINT） | 会话短 ID | 19 位 | 对照请求固定短 ID |
| 消息 `f7`（VARINT） | 发送者 UID | 16 位 | 与官方自身资料中的 UID 对照 |
| 消息 `f8`（LEN） | 正文 JSON | 存在 | 校准类型和内容结构，报告只记录允许的键名及计数 |
| 消息 `f9`（重复 LEN） | 扩展键值 | 25 项 | 只检测 `s:server_message_create_time` 等已知候选 |
| 消息 `f10`（VARINT） | 发送时间候选 | 13 位 | 数量级像毫秒是推断；需核对扩展值及页面时间 |
| 消息 `f14`（LEN） | 发送者 sec_uid | 存在 | 只作身份关联候选 |
| 消息 `f18`（LEN） | 显式引用候选 | 最后一条保留样本未出现 | 真实样本核对目标消息 ID，禁止凭文本相似度制造关系 |

[本轮结构对照输出](P1-REFERENCE-CROSSCHECK.json) 来自原始脱敏报告 `probe-2026-10-02T13-38-05-654Z.json`：1 个请求形状匹配、1 个响应形状匹配，响应集合 50 项，保留的最后一条消息前八字段形状匹配。旧扫描器只保留重复字段最后一项的嵌套形状；没有 `f18` 不能说明这 50 项均无引用。

## 本轮落地

- [history-candidate.proto](protocol/history-candidate.proto)：不完整候选 schema，注明未知时间单位与来源冲突；不参与正式采集。
- [im-protocol.ts](src/probe/im-protocol.ts)：独立实现有界只读解码，接入既有探针；不发请求，不读取浏览器 Cookie 或存储，不清缓存。
- 报告升级到 version 2，`observations.historyProtocol` 记录业务状态、会话匹配计数、消息 ID 重复计数、游标关联、时间候选和引用计数。正文、媒体链接、扩展值及原始 ID 均不保存。匿名指纹使用每次运行重新生成且不落盘的 HMAC 密钥。
- `has_more` 缺失时为 `null`；业务错误、缺失包裹层、错误线类型、截断数据和整数溢出不能被当作空历史或终点。
- `explicitEndCandidate`、`plausibleAsMilliseconds` 和内容信号都只是调查指标；每个协议结果固定 `p1Passed: false`，不会解除 P2 门槛。
- 新增 10 项合成协议测试，只验证解析、边界和脱敏，不把合成数据接入桌面界面或记为真实证据。

重新对照旧报告（完全离线）：

```powershell
npm --prefix desktop run research:check -- "$env:LOCALAPPDATA\DouyinChatArchive\probe-reports\probe-2026-10-02T13-38-05-654Z.json"
```

新版首屏只读探针：

```powershell
npm run desktop:probe
```

仍由用户在独立浏览器中正常登录、选定同一单人会话，按原提示不滚动、不发送消息。探针只观察页面自行发生的请求，**此命令尚不会主动读取三页**。浏览器可能使用缓存而不发历史请求；这种情况下报告没有交换证据，不能据此判定无历史。

## 下一轮 P1 验收顺序

1. 用新版探针取得新鲜、可解释的首屏交换，核对会话 ID、短 ID、平台消息 ID、发送者、正文 JSON 和时间候选。对真实时间做页面/扩展字段对照；原始值只在内存中使用。
2. 基于真实请求模板或已确认的页面 SDK 历史方法实现**单独的三页验证器**。沿用正常浏览器会话；保持短 ID 固定，使用响应续传值更新请求第 5 字段。鉴权、签名或缓存行为不明确时停止。当前探针没有实现这一步。
3. 对同一会话连续三页核对请求/响应对应关系、游标衔接、平台 ID 重复与跨页边界；记录消息列表滚动位置保持不变。只观察到初始 50 条不算通过。
4. 将“请求失败”“页数上限”“无推进”“空页”“显式终点”分开，验证真实终点。验证保存游标后继续读取，不能用 `has_more` 缺失或解析失败推断已完整。
5. 利用既有真实消息核对视频分享、表情、语音和显式引用。内容字段信号不能替代附件保存、播放或引用目标一致性的实测；不发送测试消息。

完成这些证据后再判定 P1，之后才能进入 P2。没有接入模拟适配器或 DOM 滚动替代路线。

## 验证记录

- 根目录类型检查、8 项测试、构建通过。
- 桌面子项目类型检查、13 项测试、构建通过。
- 旧真实报告结构对照命令通过；这是离线结构证据。
- 未运行新版探针的真实浏览器链路，未进行新的三页历史或完整导出验证。
