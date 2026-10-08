# @scuffi/gardener

The CLI for [Gardener](https://github.com/scuffi/gardener), a repository steward that runs as GitHub
Actions workflows and plans with Workers AI.

```bash
npx @scuffi/gardener generate
```

`generate` compiles `.gardener/tasks/*/TASK.md` into task bundles, writes the lock file, and
generates one GitHub Actions workflow per task. Node.js 24 or later is required.

Operators also use it to deploy the runtime and connect repositories (`deploy`, `yolo`, `upgrade`,
`doctor`, `runs`). See the [onboarding guide](https://github.com/scuffi/gardener/blob/main/docs/onboarding.md),
[creating tasks](https://github.com/scuffi/gardener/blob/main/docs/task-authoring.md), the
[task reference](https://github.com/scuffi/gardener/blob/main/docs/task-reference.md) and the
[CLI reference](https://github.com/scuffi/gardener/blob/main/docs/cli.md).

MIT licensed.
