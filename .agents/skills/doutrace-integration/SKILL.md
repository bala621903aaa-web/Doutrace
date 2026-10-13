---
name: doutrace-integration
description: Coordinate an approved DouTrace integration after independent review; use for the integration gate, never as automatic merge authorization.
---

# DouTrace integration gate

Input: task card, reviewed commit SHA, Reviewer C verdict, intended integration branch and worktree. Stop on mismatched SHA, unresolved BLOCKER, dirty target, overlap, or missing user merge approval.

1. Verify ancestry, worktree status, protected files, reviewed diff, and current release gate. Present an exact merge plan to the user for approval.
2. Only after approval, merge the reviewed branch with `--no-ff` in the dedicated integration worktree. Do not push without separate authorization.
3. Run `npm run check`, `npm test`, `npm --prefix desktop run check`, `npm --prefix desktop test`, and `npm --prefix desktop run build:dev`. For behavior changes, validate actual Electron with isolated synthetic archive data. Do not run formal release build to claim an open gate.
4. Report integrated SHA, commands, evidence, gaps, and PASS/PARTIAL/FAIL. Keep `p2GateOpen=false` unless separately authorized and proven.
