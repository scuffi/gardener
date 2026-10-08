---
"@scuffi/gardener": patch
---

Tasks now react to the issue, pull request, comment or discussion that started a run: 👀 while
the task works, then 🚀 if it applied its plan or 😕 if it failed. A run that proposes nothing
just removes 👀. Reactions only go to authors the task admits, and review submissions get none.
Two small jobs make them, so generated workflows grant `issues: write`, `pull-requests: write` or
`discussions: write` for the triggers that need it. Set `reactions: false` in a `TASK.md` to turn
them off. Run `gardener upgrade` to get them; earlier releases' workflows have no reactions.
