---
name: doutrace-feature
description: Implement an approved DouTrace development task from a task card in an isolated worktree; use for Agent A or B feature and fix work.
---

# DouTrace feature delivery

Input: approved [task card](../../../docs/tasks/TEMPLATE.md), baseline SHA, allowed files, acceptance criteria. Stop if any are missing, the tree is dirty or mismatched, or ownership overlaps.

1. Confirm HEAD, branch, worktree, current status, relevant `AGENTS.md`, [project status](../../../docs/PROJECT_STATUS.md), and task-specific contracts.
2. Implement the smallest authorized change in the assigned worktree; use offline synthetic data. Do not change release gates or shared contracts without a revised task card.
3. Run relevant focused checks, then the repository's actual scripts as required by scope. Distinguish automated results from real Electron and manual evidence.
4. Report exact changed files, complete commit SHA, tests, gaps, and risks; hand the commit to an independent Reviewer C. Do not merge or push.
