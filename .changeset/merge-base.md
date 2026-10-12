---
"@scuffi/gardener": patch
---

Tasks can now update open pull requests from a comment. A comment on a pull request, or a manual run against one, checks out its head, so a task can push fixes to it. The new `commit.merge_base` effect, with the `repository.merge_base` tool, resolves merge conflicts by adding a merge commit that brings the base branch in, without rewriting history. Projects must run `gardener upgrade` to use them. `git.*` includes `commit.merge_base` only in tasks that declare the tool, so existing tasks keep their bundle.
