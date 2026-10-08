# Contributing

Thanks for your interest in Gardener. This repository accepts issues as its public contribution
path. It does not accept unsolicited pull requests.

## Issues

Open an issue at <https://github.com/scuffi/gardener/issues/new> for:

- **Bugs and regressions.** Include the Gardener version (the `@scuffi/gardener` package, and the
  release in `.gardener/gardener.json`), the task's `TASK.md` if a task misbehaved, what you
  expected, what happened, and a link to the Actions run if the repository is public. `gardener
  doctor` and `gardener debug` print most of what helps.
- **Feature requests.** Describe the problem, who it affects and the outcome you want. A sketch of
  the `TASK.md` you would like to write makes a proposal much easier to evaluate.

## Pull requests

Please do not open a pull request unless a maintainer has asked you to. Pull requests from anyone
who is not a collaborator are closed automatically. If a maintainer asked for yours, they will add
the `allow-pr` label and reopen it.

If you already have a patch, open an issue instead and include:

- the problem the patch solves;
- the behaviour change you propose;
- the tests or commands that show the change works;
- any compatibility or migration concerns, such as changes to `TASK.md`, the lock file or the
  generated workflows.

Starting from the problem leaves room to decide whether the change fits and how it should land.

## Security reports

Do not report security issues in public issues or pull requests. Report them privately as described
in [`SECURITY.md`](SECURITY.md).

## Collaborators

Approved collaborators should follow [`COLLABORATORS.md`](COLLABORATORS.md) for setup, checks,
commits, pull requests and releases.
