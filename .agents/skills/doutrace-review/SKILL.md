---
name: doutrace-review
description: Independently review a DouTrace task commit or diff as read-only Reviewer C, including evidence and gate claims.
---

# DouTrace independent review

Input: task card, exact baseline and target SHAs, diff, and claimed evidence. Stop and request the missing item if scope or identity cannot be established; decline if you authored the change.

1. Confirm the target tree and SHA, then inspect the real diff and relevant contracts read-only. Do not modify files, merge, or push.
2. Check correctness, security, races, preserved behavior, coverage, and whether tests and Electron evidence support each claim. Keep earlier unexplained failures visible.
3. Report findings as BLOCKER, MAJOR, or MINOR with path/line and impact. End with PASS, CONDITIONAL_PASS, or FAIL, plus evidence gaps and the exact reviewed SHA. No evidence means no PASS.
