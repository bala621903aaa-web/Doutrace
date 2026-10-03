# P1 分项真实验证报告

生成时间：2026-10-03T17:37:38.520Z（Asia/Shanghai）
suite：`p1-sol-final-20261004`；任务：`recovery`；运行：`dd4ac000-5e36-41bd-8561-5ee899e2bf2d`；判定：**pass**

正式采集门：关闭。只有 `P1-ACCEPTANCE-SUMMARY` 的八项真实证据全部为 pass 且版本与当前实现匹配时，才允许进入 P2。

## 本任务适用项

| 必验项 | 判定 | 证据摘要 |
|---|---|---|
| 游标恢复 | pass | 本任务证据满足该项 |

## 其他项

- real-channel：not-run（由对应分项任务验证）。
- identity：not-run（由对应分项任务验证）。
- platform-message-id：not-run（由对应分项任务验证）。
- three-pages-no-scroll：not-run（由对应分项任务验证）。
- sent-time：not-run（由对应分项任务验证）。
- history-end：not-run（由对应分项任务验证）。
- message-semantics：not-run（由对应分项任务验证）。

## 运行概览

- 请求页数：2；捕获页数：3。
- 历史终点字段：not-attempted；终点重读：未完成。
- 恢复任务：是；控制页对账：通过。

## 隐私边界

- 未保存：认证头、Cookie、Token、请求签名。
- 未保存：原始 Protobuf/JSON 包。
- 未保存：聊天正文和媒体链接。
- 未保存：原始账号、会话、消息 ID。
- 未保存：附件内容。
- 未保存：suite 私有 HMAC 密钥。
