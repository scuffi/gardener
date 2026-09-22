# Cloudflare Access notes

The current Actions-native Gardener deployment is headless. It has no dashboard or administrative HTTP API, and no UI topology decision has been made.

The single public Gardener Worker exposes only:

- `GET /health`;
- `/session/<id>`, with mandatory GitHub OIDC authentication inside the Cap'n Web session.

Everything else returns `404`.

If an account-wide Cloudflare Access policy intercepts all `workers.dev` hostnames, the CLI can create an exact-host bypass for this runtime hostname using a locally supplied `CLOUDFLARE_API_TOKEN` scoped to Access Apps and Policies Edit. The token is never persisted or sent to GitHub or the Worker. The bypass grants network reachability only; repository authority still requires a fresh GitHub-signed OIDC token matching the enrolled repository, workflow SHA, run, attempt, commit, audience, phase, and effects environment.

The previous dashboard identity and two-Worker ingress/runtime topology are historical and remain available in Git history. A future UI may use Access, but its topology is deliberately out of scope for the headless single-Worker V1.
