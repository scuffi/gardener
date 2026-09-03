# Optional Cloudflare Access protection

Gardener's primary authentication does not require Cloudflare Access. The standard one-click deployment uses the managed Gardener Connect GitHub App for owner sign-in, a secure Gardener session for dashboard APIs, and short-lived instance-scoped Connect JWTs for event delivery. This remains the recommended default because it needs only `GARDENER_INSTANCE_TOKEN`.

Cloudflare Access is an optional outer gate for organizations that already operate Cloudflare Zero Trust. When Access protects the whole Gardener hostname, configure machine access with an Access service token. Do not create a public path bypass for `/hooks/connect`.

## Authentication layers

Human requests pass through both controls:

```text
Browser -> Cloudflare Access human policy -> Gardener GitHub owner session
```

Connect event delivery passes through both machine controls:

```text
Connect -> Cloudflare Access service token -> Connect-signed event JWT -> Gardener
```

The Access credential only admits the HTTP request through the outer gate. Gardener still rejects an absent, expired, incorrectly signed, or incorrectly audienced event JWT. A service token alone does not authorize dashboard APIs, approvals, policy changes, or GitHub operations.

## Configure the Access application

1. In **Cloudflare Zero Trust**, create or keep one self-hosted Access application for the complete Gardener hostname.
2. Keep the human **Allow** policy that protects browser access.
3. Under **Access controls -> Service credentials -> Service Tokens**, create a service token dedicated to this Gardener instance.
4. Add a policy to the same full-host application:

   | Setting | Value |
   | --- | --- |
   | Action | **Service Auth** |
   | Rule type | **Include** |
   | Selector | **Service Token** |
   | Value | The dedicated Gardener Connect token |

5. Remove any `/hooks/connect` Bypass application or policy. No path exception is needed.

Cloudflare service authentication normally uses a client ID and client secret. Treat the secret like any other production credential. Scope the policy to the dedicated token rather than **Any Access Service Token**.

## Register the token with Gardener Connect

Set both optional Worker secrets on the customer Gardener deployment:

```bash
pnpm exec wrangler secret put CLOUDFLARE_ACCESS_CLIENT_ID --config wrangler.jsonc
pnpm exec wrangler secret put CLOUDFLARE_ACCESS_CLIENT_SECRET --config wrangler.jsonc
```

Never put either value in `wrangler.jsonc`, a `.dev.vars` file committed to source control, a URL, or a support message.

Gardener registers the pair during its authenticated instance claim. An existing Gardener session performs that claim on the next dashboard load; otherwise the next **Sign in with GitHub** attempt performs it. Managed Connect encrypts the complete pair with AES-256-GCM, binds the ciphertext to the Gardener instance ID, and adds the two standard Access headers only when relaying an event to that instance's already-bound callback URL. The credentials are never returned by an API or included in logs, events, model input, grants, or operation receipts.

Both values are optional. If neither exists, Gardener explicitly keeps the standard non-Access relay mode. If only one is present, Gardener fails the claim instead of storing a partial configuration.

## Verify the two layers

First verify that an unauthenticated request is stopped by Access:

```bash
curl -I https://<gardener-host>/
```

It should redirect to the Cloudflare Access login flow.

Then send an intentionally invalid inner token with the valid Access headers:

```bash
curl -i https://<gardener-host>/hooks/connect \
  -H "CF-Access-Client-Id: $CLOUDFLARE_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CLOUDFLARE_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  --data '{"token":"verification-probe"}'
```

The expected response is Gardener's JSON `401`:

```json
{"error":"Invalid or expired event signature"}
```

That result proves that Access accepted the machine credential and Gardener independently rejected the invalid event signature. A `302` means Access did not accept the service token or its Service Auth policy. A `202` is only expected for a valid Connect-signed event.

## Rotate or remove the token

For rotation without relay downtime:

1. Create a replacement Access service token and add it to the Service Auth policy.
2. Replace both Gardener Worker secrets.
3. Reload Gardener with an authenticated Gardener session, or start GitHub sign-in once, so Gardener registers the replacement with Connect.
4. Run the invalid-token verification above with the replacement credentials.
5. Remove and revoke the old Access service token.

To return to standard mode, delete both optional Gardener Worker secrets, remove the Access application, and start GitHub sign-in once. The new claim clears the encrypted Access credential from Connect. Older Gardener versions that do not send an Access setting leave the existing Connect configuration unchanged for compatibility.

## Managed Connect requirement

The managed Connect operator must configure `ACCESS_CREDENTIAL_ENCRYPTION_KEY` as a base64url-encoded 32-byte Worker secret before accepting Access credentials. It is a separate key from Connect's JWT signing key and GitHub App private key. Rotate it only with a planned re-encryption procedure for stored per-instance credentials.

Access applications, policies, identity providers, and service tokens are not automatically provisioned by Deploy to Cloudflare. This mode is therefore optional post-deploy hardening, not part of Gardener's primary one-secret onboarding path.
