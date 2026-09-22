# Deploy to Cloudflare button (prepared, not published)

Gardener's public launch will expose a **Deploy to Cloudflare** button backed by the canonical `scuffi/gardener` repository. The repository is currently private, so the button is intentionally not published yet.

The deployment target is the same single-Worker topology used by `gardener up`:

- one public Gardener Worker exposing only `GET /health` and `/session/<id>`;
- one D1 database created from `migrations-actions/0001_actions_baseline.sql`;
- `TaskRunnerSession` and `FlueGardenerTaskHarnessAgent` Durable Objects;
- one Workers AI binding;
- no dashboard, Gateway, runner-ingress Worker, or Service Binding.

The button provisions Cloudflare infrastructure only. GitHub repository authority remains a separate explicit step:

```bash
gardener connect --workspace <workspace> --repository <owner/repository>
```

This separation preserves the no-App/no-PAT model: Cloudflare deployment never receives GitHub authority, and GitHub connection never receives Cloudflare deployment credentials.

Until the repository is public, use the equivalent end-to-end command:

```bash
gardener up --workspace <workspace> --repository <owner/repository>
```

Before publishing the button we must:

1. audit the complete Git history for credentials and private data;
2. choose the final npm package identity;
3. make `scuffi/gardener` public;
4. replace this placeholder with the public deploy URL;
5. qualify a clean button-created Worker and subsequent `gardener connect` flow.
