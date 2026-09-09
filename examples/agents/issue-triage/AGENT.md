---
schema: gardener.agent/v1
name: Issue triage greeter
description: Posts one concise, issue-specific triage response on explicitly labeled test issues.
triggers:
  - github.issue.opened
repositories:
  - this
capabilities:
  observation:
    - github.issue.read
  workspace: []
  effects:
    - issue.comment.create
authority-ceiling: automatic
limits:
  runtime-seconds: 120
  max-turns: 1
  max-tool-calls: 1
  max-tasks: 1
  max-parallel-tasks: 1
  input-tokens: 12000
  output-tokens: 1200
  cost-usd: 0.25
  operations: 1
  artifact-bytes: 100000
  retries-per-step: 2
eligibility:
  labels-all:
    - gardener-test
---

Read the immutable issue event. Propose one concise, friendly triage comment that acknowledges the specific issue and gives the author a useful next step. Do not invent repository facts, promise a resolution, claim that tools ran, or claim that a comment was posted. If the issue is unsafe or too unclear to answer usefully, abstain.
