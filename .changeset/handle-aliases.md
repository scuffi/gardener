---
"@scuffi/gardener": patch
---

New optional `aliases` setting in `.gardener/gardener.json`: other handles that also reach the project's tasks. `mentions: [self]` now matches `handle` and every alias, so people can mention the bot by a second name. Aliases need a `handle`, must not repeat it, and only count for mentions; `handle` stays the project's own identity. Upgrade the repository's pin before adding `aliases`: older releases reject the key.
