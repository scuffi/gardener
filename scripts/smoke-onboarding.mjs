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
  automationMobile: join(temporary, "03-automation-mobile.png"),
  live: join(temporary, "04-live.png"),
  liveLight: join(temporary, "04-live-light.png"),
  liveDark: join(temporary, "04-live-dark.png"),
  liveTablet: join(temporary, "04-live-tablet.png"),
  automationMenu: join(temporary, "05-automation-menu.png"),
  automationMenuMobile: join(temporary, "05-automation-menu-mobile.png"),
  accountMenu: join(temporary, "06-account-menu.png"),
  accountMenuMobile: join(temporary, "06-account-menu-mobile.png"),
  repositoriesPage: join(temporary, "07-repositories-page.png"),
  workflowsPage: join(temporary, "08-workflows-page.png"),
  workflowsPageMobile: join(temporary, "08-workflows-page-mobile.png"),
  workflowBuilderLight: join(temporary, "08-workflow-builder-light.png"),
  workflowBuilderDark: join(temporary, "08-workflow-builder-dark.png"),
  workflowBuilderMobile: join(temporary, "08-workflow-builder-mobile.png"),
  workflowDetail: join(temporary, "08-workflow-detail.png"),
  workflowDetailMobile: join(temporary, "08-workflow-detail-mobile.png"),
  workflowActivated: join(temporary, "08-workflow-activated.png"),
  workflowEdit: join(temporary, "08-workflow-edit.png"),
  workflowDraftTwo: join(temporary, "08-workflow-draft-two.png"),
  workflowRestored: join(temporary, "08-workflow-restored.png"),
  workflowsPageDraft: join(temporary, "08-workflows-page-draft.png"),
  policiesPage: join(temporary, "09-policies-page.png"),
  policiesPageFull: join(temporary, "09-policies-page-full.png"),
  policiesPageMobile: join(temporary, "09-policies-page-mobile.png"),
  approvalsPage: join(temporary, "10-approvals-page.png"),
  runsPage: join(temporary, "11-runs-page.png"),
  runDialog: join(temporary, "12-run-dialog.png"),
  settingsPage: join(temporary, "13-settings-page.png"),
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
      repository: { provider: "github", id: "101", installationId: "installation-1", owner: "cloudflare", name: "workers-sdk", defaultBranch: "main" },
      issue: { id: `issue-${issueNumber}`, number: issueNumber, title: "Bug: worker crashes on launch", body: "The worker fails immediately after startup.", state: "open", labels: [], author: "octocat", htmlUrl: `https://github.com/cloudflare/workers-sdk/issues/${issueNumber}` },
    },
  });
}
const fixturePausedEvent = issueEventToken("simulation-paused-delivery", 41);
const fixtureEvent = issueEventToken("simulation-delivery-1", 42);
const fixtureApprovalEvent = issueEventToken("simulation-approval-delivery", 43);
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
    { provider: "github", id: "101", installationId: "installation-1", owner: "cloudflare", name: "workers-sdk", defaultBranch: "main" },
    { provider: "github", id: "102", installationId: "installation-1", owner: "cloudflare", name: "agents", defaultBranch: "main" },
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
const runProcess = (command, args, options) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}: ${stderr.slice(-2_000)}`)));
});

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
  const screenshotFullPage = async (destination) => {
    const metrics = await command("Page.getLayoutMetrics");
    const size = metrics.cssContentSize;
    const capture = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
    await writeFile(destination, Buffer.from(capture.data, "base64"));
  };
  const openPage = async (label, path) => {
    await evaluate(`([...document.querySelectorAll('[data-sidebar="menu-button"]')].find((item)=>item.textContent.trim().startsWith(${JSON.stringify(label)}))).click()`);
    await waitFor(`location.pathname === ${JSON.stringify(path)} && document.querySelector('h1')?.textContent === ${JSON.stringify(label)} && document.querySelector('[data-sidebar="menu-button"][aria-current="page"]')?.textContent.trim().startsWith(${JSON.stringify(label)})`, `${label} page`);
    await sleep(150);
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
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(300);
  await screenshot(screenshots.automationMobile);
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(300);

  await evaluate(`document.querySelector('[data-profile="safe"]').click(); document.querySelector('#setup-primary').click()`);
  await waitFor(`Boolean(document.querySelector('#operating-dashboard'))`, "live dashboard");
  await sleep(200);
  await waitFor(`!document.querySelector('[data-starting-style]')`, "activation notice transition");
  await screenshot(screenshots.live);
  await evaluate(`localStorage.setItem('gardener.theme','light')`);
  await command("Page.reload");
  await waitFor(`document.documentElement.dataset.mode === 'light' && Boolean(document.querySelector('#operating-dashboard'))`, "light dashboard");
  await screenshot(screenshots.liveLight);
  await evaluate(`localStorage.setItem('gardener.theme','dark')`);
  await command("Page.reload");
  await waitFor(`document.documentElement.dataset.mode === 'dark' && Boolean(document.querySelector('#operating-dashboard'))`, "dark dashboard");
  await screenshot(screenshots.liveDark);
  await command("Emulation.setDeviceMetricsOverride", { width: 820, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await screenshot(screenshots.liveTablet);
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(300);

  await evaluate(`document.querySelector('#automation-menu-trigger').click()`);
  await waitFor(`Boolean(document.querySelector('[data-automation-menu]'))`, "automation menu");
  await screenshot(screenshots.automationMenu);
  await evaluate(`document.querySelector('[data-repository-id="101"]').click()`);
  await waitFor(`fetch('/api/state').then((response)=>response.json()).then((state)=>state.repositories.find((repository)=>repository.id==='101')?.paused===true)`, "repository pause");
  const pausedDelivery = await evaluate(`(async()=>{const r=await fetch('/hooks/connect',{method:'POST',headers:{authorization:'Bearer ${fixturePausedEvent}'}});return {status:r.status,body:await r.json()}})()`);
  if (pausedDelivery.status !== 202 || !pausedDelivery.body.paused || pausedDelivery.body.pausedBy !== 'repository' || pausedDelivery.body.runs?.length) throw new Error(`Paused repository accepted a run: ${JSON.stringify(pausedDelivery)}`);
  await evaluate(`(()=>{if(!document.querySelector('[data-automation-menu]'))document.querySelector('#automation-menu-trigger').click();return true})()`);
  await waitFor(`Boolean(document.querySelector('[data-repository-id="101"]'))`, "repository resume control");
  await evaluate(`document.querySelector('[data-repository-id="101"]').click()`);
  await waitFor(`fetch('/api/state').then((response)=>response.json()).then((state)=>state.repositories.find((repository)=>repository.id==='101')?.paused===false)`, "repository resume");
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
  await waitFor(`document.querySelector('#mobile-navigation')?.dataset.state === 'expanded'`, "mobile navigation");
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
  const approvalPolicy = await evaluate(`(async()=>{const r=await fetch('/api/policies/issue.label.add',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'approval'})});return {status:r.status,body:await r.json()}})()`);
  if (approvalPolicy.status !== 200) throw new Error(`Unable to prepare approval visual state: ${JSON.stringify(approvalPolicy)}`);
  const approvalDelivery = await evaluate(`(async()=>{const r=await fetch('/hooks/connect',{method:'POST',headers:{authorization:'Bearer ${fixtureApprovalEvent}'}});return {status:r.status,body:await r.json()}})()`);
  if (approvalDelivery.status !== 202 || !approvalDelivery.body.runs?.[0]) throw new Error(`Approval event was not accepted: ${JSON.stringify(approvalDelivery)}`);
  await waitFor(`fetch('/api/state').then((response)=>response.json()).then((state)=>state.approvals.length > 0)`, "pending approval visual state");
  const restoredPolicy = await evaluate(`(async()=>{const r=await fetch('/api/policies/issue.label.add',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'automatic'})});return {status:r.status,body:await r.json()}})()`);
  if (restoredPolicy.status !== 200) throw new Error(`Unable to restore safe policy: ${JSON.stringify(restoredPolicy)}`);
  await command("Page.reload");
  await waitFor(`Boolean(document.querySelector('#operating-dashboard')) && Boolean(document.querySelector('.table-primary-link'))`, "refreshed completed and pending runs");

  await openPage("Repositories", "/repositories");
  await screenshot(screenshots.repositoriesPage);
  await openPage("Workflows", "/workflows");
  await screenshot(screenshots.workflowsPage);
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(250);
  await screenshot(screenshots.workflowsPageMobile);
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(200);

  await evaluate(`[...document.querySelectorAll('button')].find((button)=>button.textContent?.includes('New workflow')).click()`);
  await waitFor(`location.pathname === '/workflows/new' && document.querySelector('h1')?.textContent === 'New workflow'`, "workflow builder");
  await screenshotFullPage(screenshots.workflowBuilderDark);
  await evaluate(`localStorage.setItem('gardener.theme','light')`);
  await command("Page.reload");
  await waitFor(`document.documentElement.dataset.mode === 'light' && location.pathname === '/workflows/new' && Boolean(document.querySelector('#workflow-name'))`, "light workflow builder");
  await evaluate(`(()=>{const input=document.querySelector('#workflow-name');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'Smoke issue helper');input.dispatchEvent(new Event('input',{bubbles:true}));return input.value})()`);
  await evaluate(`(()=>{const input=document.querySelector('#workflow-instructions');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(input,input.value+' Prioritize {{resource.id}} and keep the reply warm.');input.dispatchEvent(new Event('input',{bubbles:true}));return input.value})()`);
  await waitFor(`document.body.innerText.includes('Custom instructions')`, "custom agent instructions");
  await evaluate(`[...document.querySelectorAll('.builder-choice')].find((choice)=>choice.querySelector('strong')?.textContent==='Issue opened').click()`);
  await evaluate(`[...document.querySelectorAll('.builder-choice')].find((choice)=>choice.textContent?.includes('cloudflare/workers-sdk')).click()`);
  await waitFor(`!([...document.querySelectorAll('button')].find((button)=>button.textContent?.includes('Create draft'))?.disabled)`, "valid workflow draft");
  await screenshotFullPage(screenshots.workflowBuilderLight);
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(250);
  if (!await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)) throw new Error("Workflow builder overflows the mobile viewport");
  await screenshotFullPage(screenshots.workflowBuilderMobile);
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  const policiesBeforeBuilder = await evaluate(`fetch('/api/policies').then((response)=>response.json()).then((body)=>body.policies.map((policy)=>policy.operation_kind+':'+policy.mode).sort().join('|'))`);
  await evaluate(`[...document.querySelectorAll('button')].find((button)=>button.textContent?.includes('Create draft')).click()`);
  await waitFor(`location.pathname === '/workflows/smoke-issue-helper' && document.querySelector('h1')?.textContent === 'Smoke issue helper'`, "workflow draft detail");
  await screenshot(screenshots.workflowDetail);
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(250);
  if (!await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)) throw new Error("Workflow detail overflows the mobile viewport");
  await screenshotFullPage(screenshots.workflowDetailMobile);
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  await evaluate(`[...document.querySelectorAll('button')].find((button)=>button.textContent?.includes('Activate revision')).click()`);
  await waitFor(`fetch('/api/workflows/smoke-issue-helper').then((response)=>response.json()).then((body)=>body.workflow.active_revision===1)`, "workflow activation");
  await waitFor(`[...document.querySelectorAll('button')].some((button)=>button.textContent?.includes('Enable workflow'))`, "workflow enable control");
  await screenshot(screenshots.workflowActivated);
  await evaluate(`[...document.querySelectorAll('button')].find((button)=>button.textContent?.includes('Enable workflow')).click()`);
  await waitFor(`fetch('/api/workflows/smoke-issue-helper').then((response)=>response.json()).then((body)=>Boolean(body.workflow.enabled))`, "workflow enablement");
  await evaluate(`[...document.querySelectorAll('button')].find((button)=>button.textContent?.includes('Edit as new draft')).click()`);
  await waitFor(`location.pathname === '/workflows/smoke-issue-helper/edit' && document.querySelector('#workflow-name')?.disabled === true`, "workflow draft editor");
  await screenshotFullPage(screenshots.workflowEdit);
  await evaluate(`[...document.querySelectorAll('.builder-choice')].find((choice)=>choice.querySelector('strong')?.textContent==='Suggest a reply').querySelector('input').click()`);
  await waitFor(`[...document.querySelectorAll('.builder-choice')].find((choice)=>choice.querySelector('strong')?.textContent==='Suggest a reply')?.classList.contains('builder-choice--selected')===false && ![...document.querySelectorAll('button')].find((button)=>button.textContent?.includes('Save new draft'))?.disabled`, "changed workflow draft");
  await evaluate(`[...document.querySelectorAll('button')].find((button)=>button.textContent?.includes('Save new draft')).click()`);
  await waitFor(`location.pathname === '/workflows/smoke-issue-helper' && fetch('/api/workflows/smoke-issue-helper').then((response)=>response.json()).then((body)=>body.latestRevision===2 && body.workflow.active_revision===1 && Boolean(body.workflow.enabled))`, "immutable workflow draft revision");
  await screenshot(screenshots.workflowDraftTwo);
  await evaluate(`[...document.querySelectorAll('button')].find((button)=>button.textContent?.includes('Activate revision 2')).click()`);
  await waitFor(`fetch('/api/workflows/smoke-issue-helper').then((response)=>response.json()).then((body)=>body.workflow.active_revision===2)`, "second workflow revision activation");
  await evaluate(`[...document.querySelectorAll('button')].find((button)=>button.textContent?.includes('Edit as new draft')).click()`);
  await waitFor(`location.pathname === '/workflows/smoke-issue-helper/edit' && document.querySelector('#workflow-name')?.disabled === true`, "workflow reversion editor");
  await evaluate(`[...document.querySelectorAll('.builder-choice')].find((choice)=>choice.querySelector('strong')?.textContent==='Suggest a reply').querySelector('input').click()`);
  await waitFor(`[...document.querySelectorAll('.builder-choice')].find((choice)=>choice.querySelector('strong')?.textContent==='Suggest a reply')?.classList.contains('builder-choice--selected')===true && ![...document.querySelectorAll('button')].find((button)=>button.textContent?.includes('Save new draft'))?.disabled`, "restored workflow draft settings");
  await evaluate(`[...document.querySelectorAll('button')].find((button)=>button.textContent?.includes('Save new draft')).click()`);
  await waitFor(`location.pathname === '/workflows/smoke-issue-helper/revisions/1' && [...document.querySelectorAll('button')].some((button)=>button.textContent?.includes('Activate revision 1'))`, "matching saved workflow revision");
  await evaluate(`[...document.querySelectorAll('button')].find((button)=>button.textContent?.includes('Activate revision 1')).click()`);
  await waitFor(`fetch('/api/workflows/smoke-issue-helper').then((response)=>response.json()).then((body)=>body.latestRevision===2 && body.workflow.active_revision===1 && Boolean(body.workflow.enabled))`, "workflow revision restoration");
  await screenshot(screenshots.workflowRestored);
  const policiesAfterBuilder = await evaluate(`fetch('/api/policies').then((response)=>response.json()).then((body)=>body.policies.map((policy)=>policy.operation_kind+':'+policy.mode).sort().join('|'))`);
  if (policiesAfterBuilder !== policiesBeforeBuilder) throw new Error("Workflow creation changed instance operation policies");
  await openPage("Workflows", "/workflows");
  await screenshot(screenshots.workflowsPageDraft);

  await openPage("Policies", "/policies");
  const expectedPolicyNames = ["Add issue labels", "Remove issue labels", "Post issue comments", "Update issue comments", "Close issues", "Reopen issues", "Create branches", "Create commits", "Open pull requests", "Update pull requests", "Submit pull request reviews", "Merge pull requests"];
  const policyVisualState = await evaluate(`(()=>{const groups=[...document.querySelectorAll('.policy-group__header h2')].map((heading)=>heading.textContent);const names=[...document.querySelectorAll('.policy-row__copy h3')].map((heading)=>heading.textContent);const newOperations=${JSON.stringify(["branch.create", "commit.create", "pull_request.open", "pull_request.update", "pull_request.review.submit", "pull_request.merge"])};const sidebar=document.querySelector('.gardener-sidebar');return {groups,names,noRiskBadges:!document.querySelector('.policy-row__copy .status-badge'),newOperationsOff:newOperations.every((operation)=>document.querySelector('input[name="policy-'+operation+'"]:checked')?.value==='disabled'),sidebarFullHeight:Boolean(sidebar)&&sidebar.getBoundingClientRect().height>=innerHeight-1}})()`);
  if (policyVisualState.groups.join('|') !== 'Issues|Code changes|Pull requests' || policyVisualState.names.join('|') !== expectedPolicyNames.join('|') || !policyVisualState.noRiskBadges || !policyVisualState.newOperationsOff || !policyVisualState.sidebarFullHeight) throw new Error(`Policy visual state is incomplete: ${JSON.stringify(policyVisualState)}`);
  await evaluate(`document.querySelector('input[name="policy-issue.label.add"][value="approval"]')?.click()`);
  await sleep(150);
  const saveButtonState = await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find((candidate)=>candidate.textContent?.includes('Save policies'));if(!button)return {present:false};const color=getComputedStyle(button).color;const channels=color.match(/[0-9.]+/g)?.slice(0,3).map(Number)??[];return {present:true,color,bright:channels.length===3&&channels.every((channel)=>channel>=240),disabled:button.disabled}})()`);
  if (!saveButtonState.present || saveButtonState.disabled || !saveButtonState.bright) throw new Error(`Save policies button does not have an enabled white foreground: ${JSON.stringify(saveButtonState)}`);
  await screenshot(screenshots.policiesPage);
  await screenshotFullPage(screenshots.policiesPageFull);
  await evaluate(`document.querySelector('.save-bar button')?.click()`);
  await sleep(100);
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(300);
  const mobilePolicyLayout = await evaluate(`(()=>{const controls=[...document.querySelectorAll('.policy-segmented')];return {noDocumentOverflow:document.documentElement.scrollWidth<=document.documentElement.clientWidth,controlsInsideViewport:controls.every((control)=>{const rect=control.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth}),orderedNames:[...document.querySelectorAll('.policy-row__copy h3')].map((heading)=>heading.textContent)}})()`);
  if (!mobilePolicyLayout.noDocumentOverflow || !mobilePolicyLayout.controlsInsideViewport || mobilePolicyLayout.orderedNames.join('|') !== expectedPolicyNames.join('|')) throw new Error(`Mobile policy layout is invalid: ${JSON.stringify(mobilePolicyLayout)}`);
  await screenshotFullPage(screenshots.policiesPageMobile);
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const maintainerOperation = { schemaVersion: "v1", id: "visual-commit-operation", kind: "commit.create", repository: { provider: "github", id: "101", installationId: "installation-1", owner: "cloudflare", name: "workers-sdk", defaultBranch: "main" }, branch: "gardener/visual-fix", expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12", message: "Preserve executable behavior", files: [{ path: "scripts/very-long-maintenance-path-that-must-remain-readable-and-bounded-in-the-approval-card/smoke.sh", content: "#!/bin/sh\necho smoke\n" }] };
  const sqlValue = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const visualSql = `INSERT INTO proposals (id, operation_id, run_id, operation_kind, operation, policy_mode, status, rationale) VALUES (${sqlValue("visual-maintainer-proposal")}, ${sqlValue(maintainerOperation.id)}, ${sqlValue(runId)}, ${sqlValue(maintainerOperation.kind)}, ${sqlValue(JSON.stringify(maintainerOperation))}, 'approval', 'pending', 'Visual coverage for a bounded maintainer approval.');`;
  // Stop the local Worker before writing its persisted D1 database: Miniflare otherwise keeps
  // an in-memory connection whose shutdown can overwrite an out-of-process fixture insert.
  await stopProcess(worker);
  await runProcess("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", "--persist-to", join(temporary, "state"), "--command", visualSql], { cwd: appDirectory });
  // Restart only the Worker; the authenticated browser session remains intact.
  worker = spawn("pnpm", [
    "exec", "wrangler", "dev", "--port", String(appPort), "--local", "--persist-to", join(temporary, "state"),
    "--var", "AI_MODEL:gardener/deterministic-smoke", "--var", `CONNECT_ISSUER:${connectUrl}`,
    "--var", `CONNECT_URL:${connectUrl}`, "--var", "LOCAL_DEV_BYPASS:false",
  ], { cwd: appDirectory, detached: true, stdio: "ignore" });
  let restarted = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${appUrl}/api/health`)).ok) { restarted = true; break; } } catch {}
    await sleep(200);
  }
  if (!restarted) throw new Error("Gardener did not restart after inserting the maintainer visual fixture");
  await openPage("Approvals", "/approvals");
  await command("Page.reload");
  await waitFor(`[...document.querySelectorAll('.approval-card h2')].some((heading)=>heading.textContent==='Create commits')`, "maintainer approval visual state");
  if (await evaluate(`Boolean(document.querySelector('.approval-card__header .status-badge'))`)) throw new Error("Approval risk badge was rendered");
  if (!await evaluate(`[...document.querySelectorAll('.operation-preview')].some((detail)=>detail.textContent.includes('scripts/very-long-maintenance-path'))`)) throw new Error("Maintainer approval detail was not rendered");
  await screenshot(screenshots.approvalsPage);
  await openPage("Runs", "/runs");
  await screenshot(screenshots.runsPage);
  await evaluate(`document.querySelector('.table-primary-link').click()`);
  await waitFor(`Boolean(document.querySelector('.run-dialog'))`, "run detail dialog");
  await waitFor(`[...document.querySelectorAll('.run-dialog')].some((dialog)=>!dialog.hasAttribute('data-starting-style')&&!dialog.hasAttribute('data-ending-style')&&Number.parseFloat(getComputedStyle(dialog).opacity) > 0.99)`, "run detail dialog transition");
  await screenshot(screenshots.runDialog);
  await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await openPage("Settings", "/settings");
  await screenshot(screenshots.settingsPage);

  const finalState = await evaluate(`fetch('/api/state').then((response)=>response.json())`);
  const runDetail = await evaluate(`fetch('/api/runs/${runId}').then((response)=>response.json())`);
  const policies = Object.fromEntries(finalState.policies.map((policy) => [policy.operation_kind, policy.mode]));
  const builtWorkflow = finalState.workflows.find((workflow) => workflow.id === "smoke-issue-helper");
  const result = {
    passed: exceptions.length === 0,
    steps: ["account", "repositories", "automation", "live"],
    repositories: finalState.setup.activeRepositories,
    completed: finalState.setup.completed,
    paused: finalState.globalPaused,
    workflowEnabled: Boolean(finalState.workflows.find((workflow) => workflow.id === "issue-gardener")?.enabled),
    workflowBuilder: { created: Boolean(builtWorkflow), activeRevision: builtWorkflow?.active_revision, latestRevision: builtWorkflow?.revision_counter, enabled: Boolean(builtWorkflow?.enabled), policiesUnchanged: policiesAfterBuilder === policiesBeforeBuilder },
    safeProfile: { labels: policies["issue.label.add"], comments: policies["issue.comment.create"], close: policies["issue.close"], maintainerOperationsOff: ["branch.create", "commit.create", "pull_request.open", "pull_request.update", "pull_request.review.submit", "pull_request.merge"].every((operation) => policies[operation] === "disabled") },
    repositoryPause: { enforced: pausedDelivery.body.pausedBy === "repository", resumed: finalState.repositories.find((repository) => repository.id === "101")?.paused === false },
    eventFlow: { accepted: delivery.status === 202, runStatus: runDetail.run.status, proposalStatus: runDetail.proposals[0]?.status, operationKind: executedOperations[0]?.kind },
    browserExceptions: exceptions,
    screenshots,
  };
  if (!result.passed || result.repositories !== 2 || !result.completed || result.paused || !result.workflowEnabled || !result.workflowBuilder.created || result.workflowBuilder.activeRevision !== 1 || result.workflowBuilder.latestRevision !== 2 || !result.workflowBuilder.enabled || !result.workflowBuilder.policiesUnchanged || result.safeProfile.labels !== "automatic" || result.safeProfile.comments !== "approval" || result.safeProfile.close !== "disabled" || !result.safeProfile.maintainerOperationsOff || !result.repositoryPause.enforced || !result.repositoryPause.resumed || result.eventFlow.runStatus !== "completed" || result.eventFlow.proposalStatus !== "executed" || result.eventFlow.operationKind !== "issue.label.add") {
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
