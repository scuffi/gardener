---
"@scuffi/gardener": patch
---

- Runs started by someone untrusted are confined to what triggered them. Maintainers, schedules, manual runs and pushes keep today's behaviour; an outsider, a bot (Dependabot's pushes included), a fork head or anyone whose access couldn't be checked gets a run that may act only on the issue, pull request or discussion that triggered it, or on what it creates itself, and may not merge or approve a pull request it opened, edit, publish or delete releases, or re-run checks. Existing repositories get this as soon as the runtime is upgraded.
- Each task now allows an untrusted starter 3 runs a day by default. A run over the limit finishes as a skip without calling the model. Set `limits.runs-per-author` to change it (`unlimited` turns it off), and `limits.runs` to cap all of a task's runs, maintainers' included.
- `effect-scope: trigger` confines every run of a task, maintainers' included.
- `generate` warns when a task that non-maintainers can start declares a high-impact effect such as `pull_request.merge`.
- Upgrading the repository adds the same scope check at apply time; until then the runtime checks it when steps are proposed and when the plan is built.
