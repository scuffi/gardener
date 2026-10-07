---
"@scuffi/gardener": patch
---

A repository whose `.github/workflows/gardener-sync.yml` is not Gardener's can name the generated
sync workflow with `"syncWorkflow": "gardener-<name>.yml"` in `.gardener/gardener.json`. `generate`
writes the sync workflow there, and `connect` starts that workflow for the first sync. Gardener's
own repository needs this, because it publishes the reusable workflow at the default path.
Upgrading: the field is read by this release's sync and check workflows, so upgrade before adding
it.
