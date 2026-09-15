# Optional Cloudflare Access protection

Cloudflare Access is optional defense in depth, not Gardener's primary authentication. The recommended managed deployment requires only `GARDENER_INSTANCE_TOKEN`; Gardener-owned opaque workspace sessions, OAuth MCP tokens, and Connect-signed events remain the inner security boundaries. A Connect identity assertion is consumed once to create the opaque session; it is never the persistent browser cookie.

## One full-host application

When Access protects Gardener, configure one self-hosted application for the complete Gardener hostname:

- a human **Allow** policy for browser traffic;
- a **Service Auth** policy that includes one service token dedicated to this Gardener instance and managed Connect.

Do not create a public or Bypass rule for `/hooks/connect`. Do not use **Any Access Service Token**.

```text
Browser → Access human policy → Gardener opaque workspace session → dashboard/consent
Connect → Access Service Auth → Connect-signed event → Gardener event verifier
MCP client → Access policy if applicable → OAuth bearer token → MCP scope/audience checks
```

Access admission alone authorizes none of: dashboard APIs, OAuth consent, Agent publication/activation, repository assignments, interruptions, policies, membership administration, or GitHub effects. Gardener still revalidates the opaque session, active membership, role, and principal kind.

## Configure machine access

1. In Cloudflare Zero Trust, create the full-host self-hosted application.
2. Keep the human Allow policy.
3. Create a service token dedicated to this Gardener instance.
4. Add a Service Auth policy whose Include selector names that exact token.
5. Remove any path-specific webhook bypass.

Set the token pair as Gardener Worker secrets, never configuration values or committed development variables:

```bash
pnpm exec wrangler secret put CLOUDFLARE_ACCESS_CLIENT_ID --config apps/gardener/wrangler.jsonc
pnpm exec wrangler secret put CLOUDFLARE_ACCESS_CLIENT_SECRET --config apps/gardener/wrangler.jsonc
```

Both are optional, but they must be present together. Managed Connect accepts Gardener callbacks only on public `*.workers.dev` hosts (plus loopback for local development), so configure Access on that Worker hostname rather than an arbitrary relay target. During authenticated instance claim, Gardener registers the pair with Connect. Connect encrypts it with an independent AES-256-GCM key, binds it to the instance ID, and supplies standard Access headers only to the already-bound callback. The pair is never returned or included in events, prompts, models, MCP, Computer, grants, receipts, or logs.

The managed Connect operator must configure `ACCESS_CREDENTIAL_ENCRYPTION_KEY` as a base64url-encoded 32-byte Worker secret. It must not reuse a JWT or GitHub key. Rotation requires a planned re-encryption procedure.

## Verify both layers

An unauthenticated browser request should be redirected by Access:

```bash
curl -I https://<gardener-host>/
```

Then prove that a valid Access service token does not bypass the inner event verifier:

```bash
curl -i https://<gardener-host>/hooks/connect \
  -H "CF-Access-Client-Id: $CLOUDFLARE_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CLOUDFLARE_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  --data '{"token":"verification-probe"}'
```

Expected: Access admits the request and Gardener returns JSON `401` for the invalid/unsupported signed event. A redirect means the service token or Service Auth policy was not accepted. Success is expected only for a valid instance-audienced Connect event.

## Rotate or remove

For rotation:

1. Create a replacement token and add it to the exact Service Auth policy.
2. Replace both Gardener Worker secrets.
3. Perform an authenticated claim so Connect stores the replacement.
4. repeat the invalid-inner-token test;
5. remove and revoke the old token.

To leave Access mode, delete both Gardener secrets, remove the Access application/policy as appropriate, and perform an authenticated claim that explicitly clears the Connect credential. Verify direct Connect relay afterward.

Access resources are not provisioned by Deploy to Cloudflare, so this remains optional post-deploy hardening.
