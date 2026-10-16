---
"@scuffi/gardener": patch
---

- `gardener doctor` fails when the installation uses an AI Gateway but the runtime has no gateway token.
- A failed run's summary counts tool calls refused at the tool-call limit, which never ran, apart from the calls that did.
- A runtime older than the repository's workflows says to run `gardener upgrade` when it can't read the runner's event, instead of a schema error.
- `generate` and the pull request check refuse more than 100 tasks, the most one sync carries, and any `TASK.md` over 512 KiB, before compiling anything.
- The sync waits for a rate-limited runtime's `Retry-After`, up to 30 seconds, before retrying.
