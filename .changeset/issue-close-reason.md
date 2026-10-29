---
"@scuffi/gardener": patch
---

`issue.close` takes an optional `reason`, `completed` or `not_planned`, which Gardener sends to GitHub as the issue's `state_reason`. A task can now close an issue it won't fix, or one that no longer applies, as not planned rather than completed. Without `reason`, GitHub records `completed`, as before.
