# P1 真实数据通道验证报告

验证日期：2026-10-02（Asia/Shanghai）  
浏览器：独立 Chrome 配置，`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`  
探针：桌面子项目 `0.3.0` 的只读 P1 probe  
验证范围：用户正常登录后打开的指定单人私聊；未滚动消息列表，未发送任何文字、表情、视频或分享。

## 结论

**P1 未通过，停止进入 P2 采集引擎和正式桌面采集界面开发。**

真实页面确实使用了 IM Protobuf 通道，但当前证据不足以安全解释消息字段、历史游标和终点语义，也没有证明不滚动即可连续读取至少三个历史分页。不能把本次结果宣布为“支持本地数据库读取”，也不能把旧版 DOM 滚动采集接入桌面版作为静默替代。

## 已观察到的证据

### 页面与身份

- 页面为 `https://www.douyin.com/chat`，选定状态下 DOM 只呈现 13 条消息行。
- 选定状态下观测到的消息滚动位置为 0；探针没有改变滚动位置。
- 页面正常请求了 `/aweme/v1/web/user/profile/self/`，结构中出现 `user.uid`、`user.sec_uid`、`user.unique_id` 等账号字段名。字段值未写入报告，因此尚未验证稳定 ID 的跨重启一致性。
- SDK 全局对象存在 `conversationStore`，有 `curConversationId`、`conversationMap`、`hasMore`、`isLoading` 等键；本次只读快照中 `conversationMap` 有 8 个条目，但当前会话对象未能通过当前 ID 关联出来，不能把这些字段直接当作已验证会话主键或历史状态。

### 途径 A：网页 SDK

观察到以下全局候选：

- `conversationStore`
- `openImConversation`
- `@pc-im/im:1.0.0.946`
- `__VMOK_@pc-im/im:1.0.0.946__`

其中 `openImConversation` 是一个单参数函数，`conversationStore` 暴露的是会话列表和参与者相关方法，例如 `loadMoreConversations`、`fetchParticipants`、`setCurConversation`。没有观察到一个已确认“读取当前私聊更早消息”的可调用方法，也没有调用未确认的方法。途径 A 未通过。

### 途径 B：网页实际历史请求

页面实际发出了以下 IM Protobuf 请求：

- `/v1/message/get_by_conversation`
- `/v1/message/get_message_by_init`
- `/v1/message/get_user_message`
- `/v2/conversation/get_info_list`
- `/v3/conversation/get_min_index`
- `/v3/conversation/get_read_index`

`get_by_conversation` 返回约 107 KB 的 Protobuf；只做字段结构扫描时，发现嵌套消息集合的重复项计数为 50。`get_message_by_init` 返回约 2.0 MB 的 Protobuf，也包含嵌套重复结构。该证据说明页面会取得结构化 IM 数据，但字段号尚未与“平台消息 ID、发送时间、正文、会话 ID、游标”建立可验证映射。

本次没有观察到同一历史读取接口连续返回三个可比较的分页，也没有确认请求字段中哪个是可持久化游标、响应字段中哪个表示 `hasMore` 或历史终点。Protobuf 请求/响应值、认证信息和聊天正文均未保存。途径 B 未通过。

### 已读回执副作用

页面正常打开私聊时观测到 `/v3/conversation/mark_read` 请求。探针没有主动调用该接口，但打开私聊本身可能触发抖音网页的正常已读行为；这应在产品说明中明确，不能承诺“只读打开且不影响已读状态”。

## 能力判定

| 能力 | 判定 | 原因 |
|---|---|---|
| 当前账号稳定 ID | 部分证据 | 观察到账号字段名，未完成稳定性核对 |
| 稳定会话 ID | 未通过 | SDK 有候选字段，但尚未与选定会话及响应关联 |
| 平台消息 ID | 未通过 | Protobuf 字段号语义未确认 |
| 真实发送时间及单位 | 未通过 | 没有字段语义和单位证据 |
| 不滚动连续三页历史 | 未通过 | 只观察到初始加载，没有三页推进证据 |
| 游标与历史终点 | 未通过 | 未解释请求/响应中的游标和终点字段 |
| 断点恢复 | 未验证 | 没有可持久化、可解释的历史游标 |
| 视频分享、表情、引用回复 | 未验证 | 本次没有字段级真实样本证据 |

## 隐私与报告范围

探针报告只保存脱敏 URL 路径、请求方法、响应类型、Protobuf 字段号/线类型/长度分桶和 SDK 键名；不保存聊天正文、媒体、Cookie、Token、认证头、URL 参数值或原始网络响应。原始脱敏报告位于：

`C:\Users\25222\AppData\Local\DouyinChatArchive\probe-reports\probe-2026-10-02T13-38-05-654Z.json`

## 停止条件与后续入口

在获得可复核的 Protobuf schema/页面 SDK 历史方法，并实际证明游标推进、三页历史、真实消息 ID 和时间单位之前，不实现 P2、P3、P4 或 P5。当前交付只包括 P0 隔离骨架、只读探针、门槛状态页和本报告；模拟适配器没有接入正式界面。

## 2026-10-03 参考项目调查补充

已完成用户提供的三个 GitHub 项目源码调查，并顺着 DyAuthReply 的引用核对上游 `.proto`。历史请求 `8 → 301`、响应 `6 → 301` 和消息字段有了可复核候选映射；旧真实脱敏报告与这些字段形状匹配。消息第 4 字段应作为排序索引调查，不能沿用部分参考代码的“微秒发送时间”命名。第 10 字段的 13 位整数及扩展服务端时间是新一轮时间校准候选。

详见 [P1-REFERENCE-RESEARCH.md](P1-REFERENCE-RESEARCH.md) 和 [P1-REFERENCE-CROSSCHECK.json](P1-REFERENCE-CROSSCHECK.json)。新版被动探针可生成业务状态、匿名消息 ID/游标关联和内容字段计数；没有主动三页读取能力。

**P1 判定仍为未通过。** 本轮仅新增源码/离线结构证据，未完成新的真实三页、时间、终点、引用或特殊消息实测。P2 及后续开发门槛保持。
