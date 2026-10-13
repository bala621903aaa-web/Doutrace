# DouTrace 本机多 Agent 工作流（第一阶段）

本流程在 Windows 本机 Codex 中使用。项目状态看 [PROJECT_STATUS.md](PROJECT_STATUS.md)，UI 与边界看 [AGENTS.md](../AGENTS.md) 和 [Shell 契约](../P1B1-SHELL-CONTRACT.md)。角色由 `.codex/config.toml` 注册，定义位于 `.codex/agents/`，Skills 位于 `.agents/skills/`；它们提供调用入口，不会自动创建 Git Worktree、自动分派任务或自动集成。

## 生命周期

1. **主 Agent / Integration Coordinator**：取得用户授权的 [任务卡](tasks/TEMPLATE.md)，记录实际 HEAD、分支、Worktree、状态；锁定基线 SHA、允许文件、禁止文件、验收标准及所有权。先核对现有 `AGENTS.md` 和项目状态。无任务授权，不启动开发。
2. **A 或 B 开发**：A 负责获准的数据、统计、DTO 和后端范围；B 负责获准的 Renderer/UI 范围。各自在从同一批准基线创建的独立任务分支及 Worktree 中工作，按 `doutrace-feature` 交付提交 SHA 和证据。简单任务只选一位开发者。
3. **独立 C 审查**：在只读权限下按 `doutrace-review` 审查确切 SHA、真实 diff 和证据，给出 BLOCKER/MAJOR/MINOR 与 PASS/CONDITIONAL_PASS/FAIL。开发者不得充当自己提交的独立 C。FAIL 或未解决的阻断项退回原所有者修复，再审新的 SHA。
4. **集成**：主 Agent 确认受审 SHA、干净的集成 Worktree 和保护文件，呈交具体合并计划；取得用户合并授权后才按 `doutrace-integration` 执行。审查 PASS 本身不授权合并或 push；push 另需授权。正式 P1 门仍关闭。

## 并行与隔离

16GB 设备默认串行；最多主 Agent 加一名正在运行的子 Agent。只有任务卡证明文件互不重叠、共享契约已冻结、两棵独立 Worktree 均从批准基线创建且机器资源允许时，才考虑有限并行。本机 CLI 0.141.0 拒绝当前官方文档的项目级 `[agents] enabled` 写法，因此项目配置只登记三个角色；并发上限靠主 Agent 和多窗口人工核对。两个写入 Agent 发现同一 Worktree 或共同文件时停止写入，交主 Agent 重新划分或串行。共享 Shell、IPC、schema、tokens 或测试夹具按 [AGENTS.md](../AGENTS.md) 的单所有者规则串行处理。

现有对话、分支和 Worktree 保留。新任务不借用旧树的脏状态或未跟踪资产；若目标路径或分支已存在，停止并核对，不覆盖。中断后先重新读取任务卡、实际 HEAD、`git status`、`git worktree list`、最新 Reviewer 结论与已批准范围；旧会话可能未加载新配置或 Skills，应在目标 Worktree 开新会话核对发现结果。

冲突由原所有者在其任务树定向修复并提交，C 重审新的 SHA；集成树不擅自 reset、stash、rebase、clean 或改写别人的分支。若基线不明、状态冲突或凭据/真实数据边界不明，标记 **BLOCKED** 并停止相关写操作。若代码或自动化有结果但 Electron、人工或正式门证据缺失，标记 **PARTIAL** 并列明缺口；不据此宣称发布就绪。

## 本机调用与权限核对

在目标 Worktree 开启新的 Codex 会话，先请主 Agent 列出已加载的项目规则、`developer_a`、`developer_b`、`reviewer_c` 与 `doutrace-feature`、`doutrace-review`、`doutrace-integration`。按任务卡显式指定角色与 Skill；不要假设描述会自动派发。Reviewer C 的 TOML 设置 `sandbox_mode = "read-only"`，但父会话临时权限可能覆盖它；调用前把父会话设为只读，并在审查后核对 Git 状态。若无法列出或实例化自定义角色，停止将它称为已启用，只按文档人工执行，记录版本和限制。

一次新的开发请求可写：`按 $doutrace-feature 读取任务卡 <路径>，由 developer_a 或 developer_b 在独立 Worktree 实施；完成后让独立 reviewer_c 按 $doutrace-review 审查确切提交，提交集成计划并等待我批准合并。`
