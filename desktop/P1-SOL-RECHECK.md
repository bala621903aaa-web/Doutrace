# Sol 执行的 P1 真实复检

执行日期：2026-10-03～04（Asia/Shanghai）。用户已指定由 Sol 完成 P1，后续工作再交给 Luna；额度中断后已继续原任务。

**P1 已完成并通过。** 最终 suite 为 `p1-sol-final-20261004`；[验收汇总](P1-ACCEPTANCE-SUMMARY.md) 八项全部 `pass`，`implementationMatches=true`，`p2GateOpen=true`。协议映射为 `p1-history-and-init-protocol-v4`，时间映射为 `p1-official-ui-copy-time-v7`。只采用当前冻结实现的新鲜真实证据；先前 suite 保留为问题调查，不复活失效报告。P2～P5 的产品实现交给 Luna，见 [接续任务](../LUNA-P2-P5-HANDOFF.md)。

## 运行记录

| 分项 | 当前状态 | 实际动作或缺口 |
|---|---|---|
| time | pass | 16 次真实页面 copy 事件、16 个平台 ID、完整 Date 与字段 10 毫秒精确一致，顺序及两份脚本散列通过，无滚动 |
| chain | pass | 同一已有会话三页，账号/会话身份、平台 ID、游标与无滚动位置全部通过 |
| recovery prepare | 准备完成 | 已保存检查点及同游标控制页；该准备报告本身如实为 inconclusive |
| recovery resume | pass | 独立新进程恢复，与控制页消息及输出游标一致，再下一页续传通过 |
| endpoint | pass | 同账号另一会话 7 页/325 条历史响应，第 7 页 has_more=false，末页 25 条重读身份、ID 及顺序一致 |
| semantics | pass | 3 页/150 条，文本、图片、表情、视频分享、语音、视频文件信号与显式引用通过 |
| summary | pass | 八项真实通过、同账号、最终代码/协议/时间版本匹配，P2 门开放 |

## 当前实现基线

桌面类型检查、53 项测试与构建已通过；根扩展上轮类型检查、8 项测试与构建通过，25 个源码及配置文件散列未变。这些是修复回归结果，不替代真实 P1。2026-10-04 终点修复后再次冻结实现，以同窗口有界主序列减少手工操作，重新生成完整最终证据。

内置浏览器已完成登录和只读 DOM 结构核对；正式验证使用应用独立 Chrome 配置，两者登录状态不共享。用户只负责正常登录及按提示选择已有私聊，运行命令、启动采样、读取报告与判定由 Sol 执行。

最终报告路径见下文。页数上限、样本不足和错误响应没有判为通过。探针分项报告的正式采集门仍固定关闭，产品是否可接续由版本化验收汇总决定；当前汇总已允许进入 P2，产品采集、附件保存及 exe 尚待 Luna 实现。

## 首轮真实时间报告及修正

- 报告：[time-7d8f1e9a-0234-4ee1-8a65-868f0b2c996d.json](C:/Users/25222/AppData/Local/DouyinChatArchive/probe-reports/p1-p1-sol-recheck-20261003-time-7d8f1e9a-0234-4ee1-8a65-868f0b2c996d.json)。正常初始化和历史加载各 1 个来源，70 条候选；账号/会话稳定，13 个页面容器，11 个可靠行关联，滚动位置未变。时间 `matched=0`，`unresolvedConflicts=4`，如实为 `inconclusive`。
- 核对官方公开聊天模块源码，确认 wire 第 10 字段到页面时间组件的实际显示链路。新观察器只有核对到页面实际加载脚本的固定 SHA-256 后，才使用这条链路解决双候选同分钟。详见 [P1-OFFICIAL-TIME-MAPPING.md](P1-OFFICIAL-TIME-MAPPING.md)。
- 时间映射升级为 `p1-official-rendered-time-v5`；新类型检查和 41 项桌面回归通过。首轮报告因实现改变保留为问题调查，不作为最终版本通过证据。

## 额度中断前后的时间调查

`18fce370-2217-43b0-93b3-d6e3adf2e7ad` 曾采样三个真实会话窗口；第一个有 4 条完整时间对照，后两个分别只有裸时分和无时间标签。累计 4 个唯一平台 ID，主动停止，仍为 `inconclusive`。该发现说明单靠切换会话找日期标签难以补足样本，不应继续读取旧分页或降低门槛。

2026-10-04 先尝试官方页面“复制消息信息”的系统剪贴板输出，运行 `7e3d0023-3ec3-4c1c-bab7-ca2406b4ac2a` 为 `inconclusive`：输出非 JSON，未获得时间。修正为只读观察官方复制函数本次创建/选中的 DOM 文本，并核对复制模块的实际加载散列。最终版本不依赖系统剪贴板提供消息正文；剪贴板仅在内存保存并恢复原文本。

## 终点修复前的真实证据（历史记录）

- time：[6e1e7697-b208-487a-af1c-a0372f277c2d](C:/Users/25222/AppData/Local/DouyinChatArchive/probe-reports/p1-p1-sol-recheck-20261004-time-6e1e7697-b208-487a-af1c-a0372f277c2d.json)，14 个唯一 ID、14 次完整日期时间/毫秒对照、14 次顺序检查，两份脚本散列匹配，冲突 0、滚动位置不变、原剪贴板文本已恢复，`sent-time=pass`。
- chain：[5e5a9332-d94c-4c85-9049-b4ef9d001dd5](C:/Users/25222/AppData/Local/DouyinChatArchive/probe-reports/p1-p1-sol-recheck-20261004-chain-5e5a9332-d94c-4c85-9049-b4ef9d001dd5.json)，3 页，`real-channel / identity / platform-message-id / three-pages-no-scroll` 全部 `pass`。与 time 的账号 HMAC 一致。

## 终点实测发现的状态传递错误

04 日恢复 `ea9ca4cf-5d4d-4ea4-83da-ecc9325861e3` 曾真实通过同游标控制页、输出游标及下一页续传。终点第一轮 5 页/250 条仍为 `has_more=true`，没有通过；第二轮 `1ef5a0a9-8a21-4e31-9f68-bb481abbe16e` 实际在第 7 页得到 `has_more=false`，最后 25 条重读 ID 和顺序一致，却因 `sessionMatches=null` 保持未通过。

根因是后续页到终点时重新构造 EndpointFact，没有保留已累计为 true 的选中会话身份。已修正为保留前序状态，并补齐有界上限仍有更多消息时的 `page-limit` 诊断。新增实际执行两页/重读流程的合成回归，以及拒绝跨进程/未观察首屏作为批量基准的回归；桌面测试增至 53 项。

最终 `--main-sequence` 在同一正常浏览器窗口依次执行 time、semantics、chain、recovery prepare，各自生成独立报告。每项复用的首屏必须是本进程观察到的同一对象、同一页面和当前选中会话；只留在内存，不从旧报告或文件恢复请求。遇到未通过即停止；recovery 仍须另启进程 `--resume`，终点仍须另外选已有较短会话。

上述 `p1-sol-recheck-20261004` 的事实属于修复前调查，没有混入最终验收。

## 最终冻结实现的真实报告

以下均为 suite `p1-sol-final-20261004`，同账号指纹 `ce9f84b22a2681faca163e0c`；main 序列同一长会话，endpoint 明确为同账号另一条较短会话。

- [time：0fe065df-7d98-48ac-98c3-2b59a2ef730e](C:/Users/25222/AppData/Local/DouyinChatArchive/probe-reports/p1-p1-sol-final-20261004-time-0fe065df-7d98-48ac-98c3-2b59a2ef730e.json)：16 个不同 ID，16 次完整日期、字段 10 毫秒精确对照与顺序检查；两份实际加载脚本 SHA 一致，冲突 0，原剪贴板文本恢复，位置未变。
- [semantics：af499996-c199-41fd-bac9-5337983e42df](C:/Users/25222/AppData/Local/DouyinChatArchive/probe-reports/p1-p1-sol-final-20261004-semantics-af499996-c199-41fd-bac9-5337983e42df.json)：3 页/150 条，六类内容信号及显式引用通过，引用解析错误 0。附件保存和播放留待 P3。
- [chain：03b1e47c-003a-4ccd-8a2b-e6a3e04296df](C:/Users/25222/AppData/Local/DouyinChatArchive/probe-reports/p1-p1-sol-final-20261004-chain-03b1e47c-003a-4ccd-8a2b-e6a3e04296df.json)：真实通道、账号/会话身份、平台消息 ID、三页无滚动四项通过。
- [recovery prepare：e295725d-73e0-4851-9b63-9fcaaa1c68e9](C:/Users/25222/AppData/Local/DouyinChatArchive/probe-reports/p1-p1-sol-final-20261004-recovery-e295725d-73e0-4851-9b63-9fcaaa1c68e9.json)：检查点及控制页已保存，错误 0；尚未重启，故准备报告为 inconclusive。
- [recovery resume：dd4ac000-5e36-41bd-8561-5ee899e2bf2d](C:/Users/25222/AppData/Local/DouyinChatArchive/probe-reports/p1-p1-sol-final-20261004-recovery-dd4ac000-5e36-41bd-8561-5ee899e2bf2d.json)：新进程、账号/会话/短 ID/游标/实现版本相符，控制页和恢复输出游标一致，下一页续传通过，`boundaryRelation=matched-control`。
- [endpoint：440bbe84-6f47-4fd8-b6c5-221b1ea7a228](C:/Users/25222/AppData/Local/DouyinChatArchive/probe-reports/p1-p1-sol-final-20261004-endpoint-440bbe84-6f47-4fd8-b6c5-221b1ea7a228.json)：历史 7 页/325 条；明确结束响应及同游标末页 25 条重读通过，`sessionMatches=true`、`recheckMatches=true`、`recheckOrderMatches=true`。

汇总生成时间为 `2026-10-03T17:41:19.406Z`（北京时间 2026-10-04 01:41:19）。[机器可读验收汇总](P1-ACCEPTANCE-SUMMARY.json) 八项 pass、版本匹配、P2 门开放；没有被忽略或混用的旧证据。根扩展 25 个源码/配置文件再次核对未变。
