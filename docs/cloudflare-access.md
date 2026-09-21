# Cloudflare Access dashboard identity

Actions-native Gardener uses Cloudflare Access as the dashboard identity boundary. The dashboard Worker validates the Access application JWT again inside the application before granting an owner principal; an edge policy or header alone is not sufficient.

Configure the dashboard Worker with:

- `CLOUDFLARE_ACCESS_TEAM_DOMAIN`: exact HTTPS team origin, such as `https://team.cloudflareaccess.com`;
- `CLOUDFLARE_ACCESS_AUD`: exact Access application audience;
- `CLOUDFLARE_ACCESS_OWNER_EMAIL`: the single owner email, stored as a Worker secret.

Gardener verifies the `Cf-Access-Jwt-Assertion` signature against the team's `/cdn-cgi/access/certs` keys and binds the exact issuer, audience, subject, and normalized owner email. The first valid request creates or links the immutable `cloudflare-access` identity to the permanent workspace owner. A wrong email, missing claim, malformed configuration, invalid signature, wrong issuer, or wrong audience fails closed. Logout clears any legacy Gardener cookie and redirects through the team Access logout endpoint.

Protect the complete dashboard/runtime hostname with Access. Do not create a bypass for it. The dedicated runner hostname is the only public bypass:

- dashboard and API: Access protected;
- `gardener-runner-ingress` WebSocket endpoint: exact-host Access bypass, followed by mandatory GitHub OIDC authentication inside the Cap'n Web session;
- Worker-to-Worker runtime calls: private Service Binding, not public HTTP credentials.

`/api/health` reports `dashboardAuth.provider = cloudflare-access` only when all three settings exist and pass static validation. Keep `LOCAL_DEV_BYPASS=false` in every deployed environment.

The archived Gateway architecture used a reciprocal GitHub Gateway login handoff. That remains supported for historical deployments when Access identity is not configured, but it is not required by the Actions-native dashboard.
