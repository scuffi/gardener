---
"@scuffi/gardener": patch
---

- New effect `message.send`: a task can post one short message about an issue, pull request or discussion to the team's chat. Set the `GARDENER_CHAT_WEBHOOK` repository secret to a Google Chat or Slack incoming-webhook URL. Only the trusted apply step sees the URL; the model only chooses whether to post and writes a summary of up to 400 characters, which Gardener renders as plain text with links and mentions disabled. Messages are sent after every other effect has applied, at most once per plan for Google Chat and at least once for Slack. A missing secret skips the message without failing the run. Runs started by someone untrusted may only post about what triggered them. A task can't declare both `message.send` and `repository.exec`.
- `labeled` triggers now fire only when the label just added is one of the trigger's `labels-all`, so adding an unrelated label to an issue that already carries the trigger label no longer starts another run. Repositories on older workflows get a skip instead of a run for those events once the runtime is upgraded.
- Upgrading is needed only to use `message.send`. Rolling the runtime back below 0.1.18 fails in-flight runs that proposed a message.
