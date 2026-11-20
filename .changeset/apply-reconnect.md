---
"@scuffi/gardener": patch
---

The apply job now reconnects to the Gardener runtime when its connection drops, and sends the step it just recorded again, instead of failing after a step had already applied on GitHub. If it still cannot record a step, the job names the steps that applied and says to re-run failed jobs, and that re-run now finishes the plan: a pull request whose head is a commit the same plan pushed no longer fails the checkout check, so the commit step adopts that commit and the later steps run.
