---
"@scuffi/gardener": patch
---

A commit or merge no longer fails after the model runs `npm install`. Packages under an ignored `node_modules/` often ship their own `.gitattributes`, and the working-tree capture refused every run that created one. Capture now ignores a new attributes file when Git ignores its directory and nothing tracked lives under it, since it governs no path a capture can include.

When `finish_task` fails and the model stops instead of retrying, the run now says so instead of suggesting a higher `output-tokens`. A refused capture leads the failure message with its reason, is written to the run's audit trail and the Worker logs, and the model is told to fix the cause and call `finish_task` again.
