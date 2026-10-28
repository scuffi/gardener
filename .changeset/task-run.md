---
"@scuffi/gardener": patch
---

A task can now start another task with the new `task.run` effect, so one task's decision can lead straight into the next: a triage task that judges an issue worth fixing can start a fix task on it, and the fix task can start a third that announces the pull request it opened.

```yaml
effects:
  - issue.label.add
  - task.run: { tasks: [fix] }
```

The model picks one of the listed tasks and the subject: this run's own issue or pull request, or a pull request an earlier step of the plan opens. It's always the plan's last step, at most one per run, and never retried. The apply job starts it by dispatching the target task's workflow, which is why a task that declares `task.run` gets `actions: write` on its generated workflow, and only then (see `SECURITY.md`). A task that only ever runs this way can say which input it takes with the new `subject:` option on its `github.workflow_dispatch` trigger (`issue` or `pull_request`).

A started run is not a fresh start. Before dispatching, the Worker records the request, and the started run is admitted only if it matches one: it then inherits the starting run's starter decision (never a wider one) and counts against the first author's `runs-per-author`, so an outsider's issue can't buy more runs or more trust by chaining tasks. Chains stop at depth 3. A bot's manual run that matches no request, or that carries a `prompt`, is refused before the model runs.

**Behaviour change:** a `workflow_dispatch` run started by a bot or GitHub App (including another workflow using `GITHUB_TOKEN`) is now refused unless a Gardener `task.run` started it. Runs a person starts by hand are unchanged. See `docs/operations.md`.

To use `task.run`, run `gardener upgrade`: the Worker needs migration `0006`, which `upgrade` applies, and the repository's workflows need this release's pin. `gardener generate` refuses `task.run` on a project pinned to 0.1.20 or earlier, and the Worker refuses it at run time for those pins.
