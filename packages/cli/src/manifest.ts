import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { ManifestCredentials } from "./state.js";

export type AppOwner = { kind: "personal" } | { kind: "organization"; login: string };

export function githubAppManifest(
  appName: string,
  gardenerOrigin: string,
  gatewayOrigin: string,
  callbackUrl: string,
) {
  return {
    name: appName,
    url: gardenerOrigin,
    hook_attributes: {
      url: `${gatewayOrigin}/webhooks/github`,
      active: true,
    },
    redirect_url: callbackUrl,
    callback_urls: [`${gatewayOrigin}/oauth/github/callback`],
    setup_url: `${gatewayOrigin}/installations/github/callback`,
    setup_on_update: false,
    public: false,
    default_permissions: {
      metadata: "read",
      administration: "read",
      contents: "write",
      issues: "write",
      pull_requests: "write",
      checks: "read",
      discussions: "read",
      statuses: "read",
    },
    default_events: [
      "check_run",
      "check_suite",
      "discussion",
      "discussion_comment",
      // GitHub rejects installation lifecycle events in App Manifest `default_events`.
      // The Gateway still accepts those lifecycle webhooks when GitHub sends them.
      "issue_comment",
      "issues",
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "push",
      "release",
    ],
  };
}

export async function createGitHubAppFromManifest(input: {
  gardenerOrigin: string;
  gatewayOrigin: string;
  owner: AppOwner;
  appName: string;
  persistCredentials?: (credentials: ManifestCredentials) => Promise<void>;
}): Promise<ManifestCredentials> {
  const state = randomBytes(32).toString("base64url");
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  const callback = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  let startForm = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/start" && startForm) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; form-action https://github.com; script-src 'unsafe-inline'",
      });
      response.end(startForm);
      return;
    }
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.get("state") !== state) {
        response.writeHead(400, { "content-type": "text/plain", "cache-control": "no-store" });
        response.end("Gardener setup callback was invalid. Return to the terminal.");
        rejectCode(new Error("GitHub App Manifest callback state did not match"));
        return;
      }
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("GitHub App created. Return to the Gardener terminal.");
      resolveCode(code);
      return;
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start setup callback server");
  const callbackUrl = `http://127.0.0.1:${address.port}/callback`;
  const manifest = githubAppManifest(
    input.appName,
    input.gardenerOrigin,
    input.gatewayOrigin,
    callbackUrl,
  );
  const action = input.owner.kind === "organization"
    ? `https://github.com/organizations/${encodeURIComponent(input.owner.login)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  startForm = manifestForm(action, state, manifest);
  const startUrl = `http://127.0.0.1:${address.port}/start`;

  console.log(`Open this one-time setup URL if the browser does not open:\n${startUrl}`);
  openBrowser(startUrl);
  let code: string;
  try {
    code = await withTimeout(callback, 10 * 60_000, "Timed out waiting for GitHub App creation");
  } finally {
    server.close();
  }

  const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": "gardener-cli" },
  });
  const body = await response.json() as Partial<ManifestCredentials> & { message?: string };
  if (!response.ok) throw new Error(`GitHub App Manifest conversion failed: ${body.message ?? response.status}`);
  if (
    typeof body.id !== "number" || !body.slug || !body.pem || !body.webhook_secret ||
    !body.client_id || !body.client_secret || !body.owner
    || typeof body.owner.login !== "string"
    || (body.owner.type !== "User" && body.owner.type !== "Organization")
  ) {
    throw new Error("GitHub App Manifest conversion returned incomplete credentials");
  }
  const credentials = body as ManifestCredentials;
  await input.persistCredentials?.(credentials);
  return credentials;
}

function manifestForm(action: string, state: string, manifest: unknown): string {
  const escape = (value: string) => value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!doctype html><meta charset="utf-8"><title>Create Gardener GitHub App</title>` +
    `<form id="manifest" method="post" action="${escape(action)}">` +
    `<input type="hidden" name="state" value="${escape(state)}">` +
    `<input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}">` +
    `</form><p>Opening GitHub…</p><script>document.getElementById('manifest').submit()</script>`;
}

export function openBrowser(url: string): void {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  execFile(command, args, () => undefined);
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
