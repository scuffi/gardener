---
"@scuffi/gardener": patch
---

Tasks no longer write as if they were proposing something. Gardener's instructions to the model described its work as proposals ("you propose, a separate job applies"), and models carried that into the comments, pull request bodies and messages they wrote ("I propose…", "the fix I'd make…").

The model is now told that it acts by adding steps, that a trusted job applies them in order and stops at the first one that fails, and that text in a repository step is published as written once every earlier step has applied. So it writes the finished reply, in the voice of the team that runs the repository, stating what it verified and decided as fact. It never writes that a later step has happened, and it treats claims in the issue or comment as unverified. Chat messages are described as what they are: one plain-text line, without Markdown or links. The run summary, written before anything is applied, still doesn't claim the steps took effect. Refusals the model reads mid-run use the same language.

These instructions ship with the deployed Gardener Worker (`gardener upgrade`). This package also updates the task-authoring guide written to `.gardener/SKILL.md`, the starter tasks from `gardener init` and the examples, which now give direct instructions ("Comment once, concisely, with:", "Add at most two labels…") instead of "Propose…".
