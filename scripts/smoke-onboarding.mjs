#!/usr/bin/env node
import { createSign, generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const project = resolve(import.meta.dirname, "..");
const appDirectory = join(project, "apps", "gardener");
const appPort = 8810;
const connectPort = 8811;
const debugPort = 9310;
const appUrl = `http://127.0.0.1:${appPort}`;
const connectUrl = `http://127.0.0.1:${connectPort}`;
const instance = "simulated-showcase";
const instanceToken = `gdn_${instance}.simulationtokenabcdefghijklmnopqrstuvwxyz`;
const chromeBinary = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const temporary = await mkdtemp(join(tmpdir(), "gardener-onboarding-"));
const devVars = join(appDirectory, ".dev.vars");
const screenshots = {
  account: join(temporary, "01-account.png"),
  accountMobile: join(temporary, "01-account-mobile.png"),
  repositories: join(temporary, "02-repositories.png"),
  automation: join(temporary, "03-automation.png"),
  live: join(temporary, "04-live.png"),
  automationMenu: join(temporary, "05-automation-menu.png"),
  automationMenuMobile: join(temporary, "05-automation-menu-mobile.png"),
  accountMenu: join(temporary, "06-account-menu.png"),
  accountMenuMobile: join(temporary, "06-account-menu-mobile.png"),
};

const base64url = (value) => Buffer.from(value).toString("base64url");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" });

function signToken(claims) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "simulation" }));
  const payload = base64url(JSON.stringify({ iss: connectUrl, aud: instance, iat: now, exp: now + 3600, ...claims }));
  const input = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(input).end().sign(privateKey).toString("base64url");
  return `${input}.${signature}`;
}

const fixtureIdentity = signToken({ typ: "gardener-identity", sub: "424242", githubLogin: "showcase-owner" });
function issueEventToken(delivery, issueNumber) {
  return signToken({
    typ: "gardener-event",
    event: {
      schemaVersion: "v1",
      id: `github:${delivery}`,
      deliveryId: delivery,
      instanceId: instance,
      kind: "github.issue",
      action: "opened",
      occurredAt: new Date().toISOString(),
      repository: { provider: "github", id: "repo-1", installationId: "installation-1", owner: "cloudflare", name: "workers-sdk", defaultBranch: "main" },
      issue: { id: `issue-${issueNumber}`, number: issueNumber, title: "Bug: worker crashes on launch", body: "The worker fails immediately after startup.", state: "open", labels: [], author: "octocat", htmlUrl: `https://github.com/cloudflare/workers-sdk/issues/${issueNumber}` },
    },
  });
}
const fixturePausedEvent = issueEventToken("simulation-paused-delivery", 41);
const fixtureEvent = issueEventToken("simulation-delivery-1", 42);
const executedOperations = [];
const connect = createServer(async (request, response) => {
  const url = new URL(request.url || "/", connectUrl);
  const reply = (status, body) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === "/v1/instances/claim" && request.method === "POST") return reply(200, { claimed: true, instanceId: instance });
  if (url.pathname === "/v1/auth/github/start" && request.method === "POST") return reply(200, { authorizationUrl: `${appUrl}/#identity_token=${fixtureIdentity}` });
  if (url.pathname === "/v1/installations/setup" && request.method === "POST") return reply(200, { installationUrl: `${appUrl}/?installation=complete` });
  if (url.pathname === "/v1/repositories" && request.method === "GET") return reply(200, { repositories: [
    { provider: "github", id: "repo-1", installationId: "installation-1", owner: "cloudflare", name: "workers-sdk", defaultBranch: "main" },
    { provider: "github", id: "repo-2", installationId: "installation-1", owner: "cloudflare", name: "agents", defaultBranch: "main" },
  ] });
  if (url.pathname === "/v1/grants" && request.method === "POST") return reply(200, { grant: "simulation-grant" });
  if (url.pathname === "/v1/operations" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const operation = JSON.parse(body).operation;
    executedOperations.push(operation);
    return reply(200, { schemaVersion: "v1", operationId: operation.id, status: "applied", provider: "github", externalId: "simulation-receipt", appliedAt: new Date().toISOString() });
  }
  return reply(404, { error: `Simulation has no ${request.method} ${url.pathname}` });
});

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const stopProcess = async (child) => {
  if (!child) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await sleep(350);
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
};
const listen = (server, port) => new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolvePromise);
});
const close = (server) => new Promise((resolvePromise) => server.close(resolvePromise));

let worker;
let chrome;
let socket;
try {
  await listen(connect, connectPort);
  await writeFile(devVars, `GARDENER_INSTANCE_TOKEN=${instanceToken}\nCONNECT_PUBLIC_KEY=${String(publicPem).replaceAll("\n", "\\n")}\n`, { mode: 0o600 });
  worker = spawn("pnpm", [
    "exec", "wrangler", "dev", "--port", String(appPort), "--local", "--persist-to", join(temporary, "state"),
    "--var", "AI_MODEL:gardener/deterministic-smoke",
    "--var", `CONNECT_ISSUER:${connectUrl}`,
    "--var", `CONNECT_URL:${connectUrl}`,
    "--var", "LOCAL_DEV_BYPASS:false",
  ], { cwd: appDirectory, detached: true, stdio: "ignore" });

  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${appUrl}/api/health`)).ok) { ready = true; break; } } catch {}
    await sleep(200);
  }
  if (!ready) throw new Error("Gardener did not start");

  chrome = spawn(chromeBinary, [
    "--headless=new", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${join(temporary, "chrome")}`, "about:blank",
  ], { detached: true, stdio: "ignore" });
  let debugging = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) { debugging = true; break; } } catch {}
    await sleep(100);
  }
  if (!debugging) throw new Error(`Chrome DevTools did not start. Set CHROME_BIN if Chrome is installed elsewhere.`);

  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => { socket.onopen = resolvePromise; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  const exceptions = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const [resolvePromise, reject] = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolvePromise(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      exceptions.push(details.exception?.description || details.text || "Browser exception");
    }
  };
  const command = (method, params = {}) => new Promise((resolvePromise, reject) => {
    const id = ++sequence;
    pending.set(id, [resolvePromise, reject]);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
    return result.result.value;
  };
  const waitFor = async (expression, label) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    const context = await evaluate(`({url: location.href, text: document.body.innerText.slice(0, 1600)})`);
    throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(context)}; browserExceptions=${JSON.stringify(exceptions)}`);
  };
  const screenshot = async (destination) => {
    const capture = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(destination, Buffer.from(capture.data, "base64"));
  };

  await command("Runtime.enable");
  await command("Page.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await command("Page.navigate", { url: appUrl });
  await waitFor(`document.querySelector('#setup-primary')?.dataset.action === 'signin'`, "account step");
  await screenshot(screenshots.account);
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(250);
  await screenshot(screenshots.accountMobile);
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  await evaluate(`document.querySelector('#setup-primary').click()`);
  await waitFor(`document.querySelector('#setup-primary')?.dataset.action === 'install'`, "repository step");
  await screenshot(screenshots.repositories);

  await evaluate(`document.querySelector('#setup-primary').click()`);
  await waitFor(`document.querySelector('#setup-primary')?.dataset.action === 'activate'`, "automation step");
  await screenshot(screenshots.automation);

  await evaluate(`document.querySelector('[data-profile="safe"]').click(); document.querySelector('#setup-primary').click()`);
  await waitFor(`Boolean(document.querySelector('#operating-dashboard'))`, "live dashboard");
  await screenshot(screenshots.live);

  await evaluate(`document.querySelector('#automation-menu-trigger').click()`);
  await waitFor(`Boolean(document.querySelector('[data-automation-menu]'))`, "automation menu");
  await screenshot(screenshots.automationMenu);
  await evaluate(`document.querySelector('[data-repository-id="repo-1"]').click()`);
  await waitFor(`fetch('/api/state').then((response)=>response.json()).then((state)=>state.repositories.find((repository)=>repository.id==='repo-1')?.paused===true)`, "repository pause");
  const pausedDelivery = await evaluate(`(async()=>{const r=await fetch('/hooks/connect',{method:'POST',headers:{authorization:'Bearer ${fixturePausedEvent}'}});return {status:r.status,body:await r.json()}})()`);
  if (pausedDelivery.status !== 202 || !pausedDelivery.body.paused || pausedDelivery.body.pausedBy !== 'repository' || pausedDelivery.body.runs?.length) throw new Error(`Paused repository accepted a run: ${JSON.stringify(pausedDelivery)}`);
  await evaluate(`(()=>{if(!document.querySelector('[data-automation-menu]'))document.querySelector('#automation-menu-trigger').click();return true})()`);
  await waitFor(`Boolean(document.querySelector('[data-repository-id="repo-1"]'))`, "repository resume control");
  await evaluate(`document.querySelector('[data-repository-id="repo-1"]').click()`);
  await waitFor(`fetch('/api/state').then((response)=>response.json()).then((state)=>state.repositories.find((repository)=>repository.id==='repo-1')?.paused===false)`, "repository resume");
  await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });

  await evaluate(`document.querySelector('#account-menu-trigger').click()`);
  await waitFor(`Boolean(document.querySelector('[data-account-menu]'))`, "account menu");
  await screenshot(screenshots.accountMenu);
  await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await command("Page.reload");
  await waitFor(`Boolean(document.querySelector('#operating-dashboard'))`, "mobile dashboard");
  await sleep(250);
  await evaluate(`document.querySelector('#automation-menu-trigger').click()`);
  await waitFor(`Boolean(document.querySelector('[data-automation-menu]'))`, "mobile automation menu");
  await screenshot(screenshots.automationMenuMobile);
  await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await evaluate(`document.querySelector('.mobile-menu').click()`);
  await waitFor(`document.querySelector('#mobile-navigation').classList.contains('sidebar--open')`, "mobile navigation");
  await waitFor(`Math.abs(document.querySelector('#mobile-navigation').getBoundingClientRect().x) < 1`, "mobile navigation transition");
  await evaluate(`document.querySelector('#account-menu-trigger').click()`);
  await waitFor(`Boolean(document.querySelector('[data-account-menu]'))`, "mobile account menu");
  await screenshot(screenshots.accountMenuMobile);
  await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await command("Page.reload");
  await waitFor(`Boolean(document.querySelector('#operating-dashboard'))`, "restored desktop dashboard");

  const delivery = await evaluate(`(async()=>{const r=await fetch('/hooks/connect',{method:'POST',headers:{authorization:'Bearer ${fixtureEvent}'}});return {status:r.status,body:await r.json()}})()`);
  if (delivery.status !== 202 || !delivery.body.runs?.[0]) throw new Error(`Simulated event was not accepted: ${JSON.stringify(delivery)}`);
  const runId = delivery.body.runs[0];
  await waitFor(`(async()=>{const r=await fetch('/api/runs/${runId}');if(!r.ok)return false;const body=await r.json();return body.run.status==='completed'&&body.proposals?.[0]?.status==='executed'})()`, "automatic typed operation");

  const finalState = await evaluate(`fetch('/api/state').then((response)=>response.json())`);
  const runDetail = await evaluate(`fetch('/api/runs/${runId}').then((response)=>response.json())`);
  const policies = Object.fromEntries(finalState.policies.map((policy) => [policy.operation_kind, policy.mode]));
  const result = {
    passed: exceptions.length === 0,
    steps: ["account", "repositories", "automation", "live"],
    repositories: finalState.setup.activeRepositories,
    completed: finalState.setup.completed,
    paused: finalState.globalPaused,
    workflowEnabled: Boolean(finalState.workflows[0]?.enabled),
    safeProfile: { labels: policies["issue.label.add"], comments: policies["issue.comment.create"], close: policies["issue.close"] },
    repositoryPause: { enforced: pausedDelivery.body.pausedBy === "repository", resumed: finalState.repositories.find((repository) => repository.id === "repo-1")?.paused === false },
    eventFlow: { accepted: delivery.status === 202, runStatus: runDetail.run.status, proposalStatus: runDetail.proposals[0]?.status, operationKind: executedOperations[0]?.kind },
    browserExceptions: exceptions,
    screenshots,
  };
  if (!result.passed || result.repositories !== 2 || !result.completed || result.paused || !result.workflowEnabled || result.safeProfile.labels !== "automatic" || result.safeProfile.comments !== "approval" || result.safeProfile.close !== "disabled" || !result.repositoryPause.enforced || !result.repositoryPause.resumed || result.eventFlow.runStatus !== "completed" || result.eventFlow.proposalStatus !== "executed" || result.eventFlow.operationKind !== "issue.label.add") {
    throw new Error(`Onboarding assertions failed: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  socket?.close();
  await stopProcess(chrome);
  await stopProcess(worker);
  if (connect.listening) await close(connect);
  await rm(devVars, { force: true });
  if (process.env.KEEP_SMOKE_ARTIFACTS !== "true") await rm(temporary, { recursive: true, force: true });
}
