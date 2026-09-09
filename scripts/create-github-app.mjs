#!/usr/bin/env node
import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const connectUrl = new URL(process.argv[2] || "https://gardener-connect.agents-b8a.workers.dev");
const state = crypto.randomUUID();
const appName = process.env.GARDENER_GITHUB_APP_NAME || `Gardener Connect Dev ${crypto.randomUUID().slice(0, 6)}`;

const server = createServer();
server.on("request", async (request, response) => {
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
  if (requestUrl.pathname === "/") {
    const redirectUrl = `http://127.0.0.1:${server.address().port}/callback`;
    const manifest = {
      name: appName,
      url: connectUrl.toString(),
      hook_attributes: { url: new URL("/github/webhook", connectUrl).toString(), active: true },
      redirect_url: redirectUrl,
      callback_urls: [
        new URL("/v1/landing/callback", connectUrl).toString(),
        new URL("/v1/auth/github/callback", connectUrl).toString(),
      ],
      setup_url: new URL("/v1/installations/callback", connectUrl).toString(),
      setup_on_update: true,
      public: false,
      default_permissions: {
        administration: "read",
        checks: "read",
        contents: "write",
        discussions: "write",
        issues: "write",
        metadata: "read",
        pull_requests: "write",
        statuses: "read",
      },
      // Installation lifecycle events are implicit for GitHub Apps and are rejected by the manifest API when listed here.
      default_events: [
        "check_run",
        "check_suite",
        "discussion",
        "discussion_comment",
        "issue_comment",
        "issues",
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
        "push",
        "release",
      ],
    };
    const encoded = String(JSON.stringify(manifest)).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><title>Create Gardener GitHub App</title><body style="font:16px system-ui;background:#09100b;color:#eef7ef;display:grid;place-items:center;min-height:100vh;margin:0"><form id="form" action="https://github.com/settings/apps/new?state=${state}" method="post"><input type="hidden" name="manifest" value="${encoded}"><p>Opening GitHub to create <strong>${appName}</strong>…</p></form><script>document.querySelector('#form').submit()</script></body>`);
    return;
  }

  if (requestUrl.pathname !== "/callback" || requestUrl.searchParams.get("state") !== state) {
    response.writeHead(400, { "content-type": "text/plain" });
    response.end("Invalid GitHub App manifest callback.");
    return;
  }

  const code = requestUrl.searchParams.get("code");
  if (!code) {
    response.writeHead(400, { "content-type": "text/plain" });
    response.end("GitHub returned no manifest conversion code.");
    return;
  }

  try {
    const conversion = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "user-agent": "gardener-connect-setup", "x-github-api-version": "2022-11-28" },
    });
    const app = await conversion.json();
    if (!conversion.ok) throw new Error(app.message || `GitHub conversion failed (${conversion.status})`);
    const directory = join(homedir(), ".config", "gardener");
    const destination = join(directory, "github-app.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(destination, `${JSON.stringify(app, null, 2)}\n`, { mode: 0o600 });
    await chmod(destination, 0o600);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><body style="font:16px system-ui;background:#09100b;color:#eef7ef;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:560px;padding:32px"><h1 style="color:#a4f783">GitHub App created</h1><p><strong>${app.name}</strong> is ready. Credentials were saved locally with owner-only permissions. You can close this tab and return to Gardener.</p></main></body>`);
    console.log(JSON.stringify({ created: true, id: app.id, slug: app.slug, clientId: app.client_id, credentials: destination }));
    setTimeout(() => server.close(), 250);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(error instanceof Error ? error.message : "Unable to convert GitHub App manifest");
    console.error(error);
    setTimeout(() => server.close(), 250);
  }
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Opening GitHub App creation for ${appName}…`);
  execFile("open", [url]);
});
