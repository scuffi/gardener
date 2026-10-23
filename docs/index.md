---
layout: home
title: Gardener
titleTemplate: AI that tends your GitHub repositories

hero:
  name: Gardener
  text: Your repositories, tended.
  tagline: Triage the weeds, answer the mentions, keep the docs watered. Write each chore as a Markdown task, fence in exactly what it may touch, and let it grow on GitHub Actions.
  image:
    src: /gardener.svg
    alt: A git graph growing into a plant
  actions:
    - theme: brand
      text: Plant your first task
      link: /getting-started
    - theme: alt
      text: How tasks work
      link: /task-authoring
    - theme: alt
      text: View on GitHub
      link: https://github.com/scuffi/gardener

features:
  - icon: 🌱
    title: Planted in Markdown
    details: One TASK.md says when it runs, what it may read and which changes it may make. The body is plain instructions for the model.
  - icon: ✂️
    title: Pruned to what you allow
    details: The model only proposes. A separate job applies just the declared effects, from a plan sealed with a hash. Nothing grows past the fence.
  - icon: 🪴
    title: Grows in your own soil
    details: A Worker with Workers AI and D1 in your Cloudflare account, plus workflows in your repo. No GitHub App, webhook or stored token.
  - icon: 🌦️
    title: Every season covered
    details: 29 kinds of trigger, from issues and pull requests to pushes and schedules. 36 GitHub operations, from labels to releases.
---

<section class="gd-section">

<p class="gd-eyebrow">The seed packet</p>

## A task is one Markdown file

<p class="gd-lede">Everything Gardener may do is written on the packet. If a change isn't declared, the model can't make it, whatever the instructions say.</p>

<div class="gd-packet">

<ul>
  <li><strong>trigger</strong><span>When it sprouts: a new issue, a mention, a push, every Monday morning.</span></li>
  <li><strong>tools</strong><span>What it can look at while it works: files, the GitHub API, commands.</span></li>
  <li><strong>effects</strong><span>The only changes it may make. Workflow token permissions are derived from this list.</span></li>
  <li><strong>network</strong><span>Where it may reach. Denied, unless the task runs commands.</span></li>
  <li><strong>limits</strong><span>How big it can grow: runtime, turns, tool calls and tokens.</span></li>
</ul>

```markdown
---
schema: gardener.task/v1
id: triage
name: Triage
description: Summarises new issues, points out likely duplicates, and applies existing labels.
trigger:
  event: github.issue.opened
tools:
  - repository.list_files
  - repository.read_file
  - provider.api.read
effects:
  - issue.comment.create
  - issue.label.add
network:
  default: deny
  allow: []
  deny: []
limits:
  runtime-seconds: 300
  max-turns: 12
  max-tool-calls: 16
  input-tokens: 80000
  output-tokens: 16000
---
Triage the issue that triggered this run. List the repository's
labels, search for similar open issues, then comment with a
short summary, link any likely duplicate, and add the labels
that fit.
```

</div>
</section>

<section class="gd-section">

<p class="gd-eyebrow">How it grows</p>

## Plan, then apply

<p class="gd-lede">Every task compiles to a GitHub workflow with two jobs, and neither one gets both the model and a write token.</p>

<div class="gd-steps">
  <div class="gd-step">
    <span class="gd-tag">read-only</span>
    <h3>Plan</h3>
    <p>The model explores your repository through the task's declared tools and proposes effects. Your Worker checks each one and returns an exact, hash-bound plan.</p>
  </div>
  <div class="gd-step">
    <span class="gd-tag">no checkout</span>
    <h3>Apply</h3>
    <p>A second job verifies the plan's hash, then makes each change with the job's <code>GITHUB_TOKEN</code>. It re-checks GitHub before every write and stops at the first surprise.</p>
  </div>
</div>

<p class="gd-callout">🌿 The model never holds a write-capable token, and the job holding one never runs repository code.</p>

</section>

<section class="gd-section">

<p class="gd-eyebrow">Ideas for your plot</p>

## What will you grow?

<p class="gd-lede">These tasks tend the Gardener repository itself. Copy one into <code>.gardener/tasks/</code> and adapt it.</p>

<div class="gd-beds">
  <a class="gd-bed" href="https://github.com/scuffi/gardener/blob/main/.gardener/tasks/triage/TASK.md">
    <span class="gd-bed-icon">🐛</span>
    <strong>Triage</strong>
    <span>Labels new issues, points out duplicates, and closes empty or invalid ones.</span>
    <em>on issue opened</em>
  </a>
  <a class="gd-bed" href="https://github.com/scuffi/gardener/blob/main/.gardener/tasks/mention-reply/TASK.md">
    <span class="gd-bed-icon">💬</span>
    <strong>Mention reply</strong>
    <span>Does what a maintainer asks when they mention the bot, from answering questions to opening pull requests.</span>
    <em>on mention</em>
  </a>
  <a class="gd-bed" href="https://github.com/scuffi/gardener/blob/main/.gardener/tasks/dependabot-merge/TASK.md">
    <span class="gd-bed-icon">🤖</span>
    <strong>Dependabot merge</strong>
    <span>Merges Dependabot pull requests whose checks all passed, and flags any that need a person.</span>
    <em>every four hours</em>
  </a>
  <a class="gd-bed" href="https://github.com/scuffi/gardener/blob/main/.gardener/tasks/docs-review/TASK.md">
    <span class="gd-bed-icon">📚</span>
    <strong>Docs review</strong>
    <span>Compares the docs with the code and opens one issue listing what is out of date.</span>
    <em>every Monday</em>
  </a>
  <a class="gd-bed" href="https://github.com/scuffi/gardener/blob/main/.gardener/tasks/examples-review/TASK.md">
    <span class="gd-bed-icon">🧪</span>
    <strong>Examples review</strong>
    <span>Runs the examples, compares them with the code, and opens a draft pull request with fixes.</span>
    <em>every Monday</em>
  </a>
  <a class="gd-bed" href="https://github.com/scuffi/gardener/blob/main/.gardener/tasks/test-coverage-review/TASK.md">
    <span class="gd-bed-icon">🔍</span>
    <strong>Test coverage review</strong>
    <span>Reads the code and tests and opens one issue naming important untested behaviour.</span>
    <em>every Monday</em>
  </a>
</div>

</section>

<section class="gd-ground">

## Break ground in one command

<p>Scaffolds two demo tasks, deploys the Worker and D1 database to your Cloudflare account, enrolls your repository and checks the install. It never commits, so you review and push.</p>

```bash
npx @scuffi/gardener yolo --workspace my-gardener --repository my-org/my-repo --demos
```

<div class="gd-actions">
  <a class="brand" href="/getting-started">Get started</a>
  <a class="alt" href="/task-reference">Task reference</a>
</div>

</section>

<p class="gd-footnote">Gardener is pre-release. Effects apply without a human approval step, so declare the narrowest effects you can.</p>
