# Optional Cloudflare Access

Cloudflare Access is defense in depth for the public Gardener dashboard. It is not Gardener's product
identity protocol and it is not required for private Worker-to-Worker calls.

The customer-owned GitHub Gateway and Gardener communicate through named Cloudflare Service Bindings.
Do not create public callback credentials, Access service tokens, instance bearer tokens, or route
bypasses for those RPC methods.

If Access protects Gardener:

1. create one full-host Access application for the Gardener workers.dev hostname;
2. add the customer's human identity policy;
3. verify that the browser can reach `/api/auth/start` and receive the Gateway-completed redirect;
4. keep Gardener's opaque local session, active membership, role checks, and same-origin write checks;
5. do not expose `GardenerGitHubEntrypoint` through an HTTP route.

The Gateway's public GitHub routes must remain reachable by GitHub and the OAuth browser flow:

- `/oauth/github/callback`
- `/installations/github/callback`
- `/webhooks/github`

Do not place a full-host Access challenge in front of the Gateway unless route-level policies preserve
those callbacks. `/ops/*` is protected by the independent Gateway operator token and returns only
sanitized delivery diagnostics; Access may be added around it, but never replaces that token.

Access headers are not provider identity and must not be used to select owner/member roles. GitHub's
immutable numeric subject arrives only through the Gateway login handoff. Repository authority comes
only from the dedicated GitHub App installations.

Operational checks:

- `/api/health` reports the Gateway binding ready from Gardener.
- Gateway `/health` reports its reverse binding ready.
- Browser logout/revocation remains effective even while an Access session is valid.
- A valid Access session without a Gardener session receives `authentication_required`.
- GitHub webhooks still receive `202` after signature verification and durable persistence.
- Provider operation execution has no public HTTP path.
