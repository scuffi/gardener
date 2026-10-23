---
layout: home

hero:
  name: Gardener
  text: AI maintenance tasks for your GitHub repositories
  tagline: Describe a task in Markdown. A model does the work inside the task's limits, and a separate job applies only the changes the task allows.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Creating tasks
      link: /task-authoring
    - theme: alt
      text: GitHub
      link: https://github.com/scuffi/gardener

features:
  - title: Runs in your accounts
    details: A Cloudflare Worker with Workers AI and D1, plus Actions workflows in your repository. No GitHub App, webhook, personal access token, or stored GitHub secret.
  - title: Plan, then apply
    details: The model plans with a read-only token and proposes effects. A second job with no checkout verifies the hash-bound plan and applies only what the task allows.
  - title: Tasks are Markdown
    details: YAML frontmatter declares when a task runs, what it may read and which changes it may make. The body is the model's instructions.
---
