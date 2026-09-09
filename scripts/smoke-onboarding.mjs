#!/usr/bin/env node
import { createSign, generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
const temporary = await mkdtemp(join(tmpdir(), "gardener-agent-smoke-"));
const devVars = join(appDirectory, ".dev.vars");
const screenshots = Object.fromEntries(["inbox", "agents", "agent-light", "agent-dark", "history", "policies", "settings", "editor-zoom", "editor-mobile"].map((name, index) => [name, join(temporary, `${String(index + 1).padStart(2, "0")}-${name}.png`)]));
const agentSource = `---
schema: gardener.agent/v1
name: Smoke issue gardener
description: Reviews newly opened issues without persistent effects
triggers:
  - github.issue.opened
repositories:
  - this
capabilities:
  observation:
    - github.issue.read
  workspace: []
  effects: []
authority-ceiling: approval
limits:
  max-turns: 4
  max-tool-calls: 10
  max-parallel-tasks: 3
---
Read the issue carefully and summarize missing context. Never claim an effect was executed.
`;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" });
const base64url = (value) => Buffer.from(value).toString("base64url");
function signToken(claims) {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "simulation" }));
  const payload = base64url(JSON.stringify({ iss: connectUrl, aud: instance, iat: now, exp: now + 3_600, ...claims }));
  const input = `${header}.${payload}`;
  return `${input}.${createSign("RSA-SHA256").update(input).end().sign(privateKey).toString("base64url")}`;
}
const eventToken = signToken({
  typ: "gardener-event",
  event: {
    schemaVersion: "v2", id: "github:smoke-delivery", deliveryId: "smoke-delivery", instanceId: instance,
    kind: "github.issue", action: "opened", occurredAt: new Date().toISOString(),
    repository: { provider: "github", id: "101", installationId: "201", owner: "cloudflare", name: "workers-sdk", defaultBranch: "main" },
    actor: { id: "42", login: "octocat", accountType: "User" },
    resourceAuthor: { id: "42", login: "octocat", accountType: "User" },
    issue: { id: "301", number: 42, title: "Smoke issue", body: "Synthetic smoke input", state: "open", labels: [], locked: false, updatedAt: new Date().toISOString(), htmlUrl: "https://github.com/cloudflare/workers-sdk/issues/42" },
  },
});

const connectRequests = [];
const connect = createServer(async (request, response) => {
  const url = new URL(request.url || "/", connectUrl);
  connectRequests.push(`${request.method} ${url.pathname}`);
  response.setHeader("content-type", "application/json");
  if (url.pathname === "/v1/repositories" && request.method === "GET") {
    response.end(JSON.stringify({ repositories: [{ provider: "github", id: "101", installationId: "201", owner: "cloudflare", name: "workers-sdk", defaultBranch: "main" }] }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: `No smoke fixture for ${request.method} ${url.pathname}` }));
});

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const stop = async (child) => {
  if (!child) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await sleep(250);
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
};
const listen = (server, port) => new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolvePromise); });
const close = (server) => new Promise((resolvePromise) => server.close(resolvePromise));
async function json(path, init = {}) {
  const response = await fetch(`${appUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(`${init.method || "GET"} ${path} failed (${response.status}): ${JSON.stringify(body)}`);
  return { response, body };
}

let priorDevVars;
let worker;
let chrome;
let socket;
try {
  try { priorDevVars = await readFile(devVars); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await listen(connect, connectPort);
  await writeFile(devVars, `GARDENER_INSTANCE_TOKEN=${instanceToken}\nCONNECT_PUBLIC_KEY=${String(publicPem).replaceAll("\n", "\\n")}\n`, { mode: 0o600 });
  worker = spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(appPort), "--local", "--persist-to", join(temporary, "state"), "--var", "AI_MODEL:gardener/deterministic-smoke", "--var", `CONNECT_ISSUER:${connectUrl}`, "--var", `CONNECT_URL:${connectUrl}`, "--var", "LOCAL_DEV_BYPASS:true"], { cwd: appDirectory, detached: true, stdio: "ignore" });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${appUrl}/api/health`)).status === 200) break; } catch {}
    if (attempt === 99) throw new Error("Gardener did not start");
    await sleep(150);
  }

  await json("/api/repositories/sync", { method: "POST" });
  await json("/api/setup/activate", { method: "POST", body: JSON.stringify({ profile: "safe" }) });
  const validation = (await json("/api/agents/validate", { method: "POST", body: JSON.stringify({ sourceMd: agentSource }) })).body;
  if (!validation.valid || !validation.publishable) throw new Error(`Agent source did not validate: ${JSON.stringify(validation)}`);
  const simulation = (await json("/api/agents/simulate", { method: "POST", body: JSON.stringify({ sourceMd: agentSource }) })).body;
  if (simulation.status !== "blocked" || simulation.executed !== false) throw new Error(`Simulation was not fail closed: ${JSON.stringify(simulation)}`);
  const created = (await json("/api/agents", { method: "POST", body: JSON.stringify({ sourceMd: agentSource }) })).body;
  const agentId = created.agent.id;
  const published = (await json(`/api/agents/${agentId}/revisions`, { method: "POST", body: JSON.stringify({ sourceMd: agentSource }) })).body;
  if (published.revision !== 1 || !published.paused) throw new Error(`Publication was not paused: ${JSON.stringify(published)}`);
  await json(`/api/agents/${agentId}/revisions/1/activate`, { method: "POST", body: "{}" });
  await json(`/api/agents/${agentId}/status`, { method: "POST", body: JSON.stringify({ enabled: true }) });
  const detail = (await json(`/api/agents/${agentId}`)).body;
  if (!detail.agent.enabled || detail.agent.activeRevision !== 1 || detail.agent.latestRevision !== 1) throw new Error(`Lifecycle boundary failed: ${JSON.stringify(detail.agent)}`);

  const delivery = await fetch(`${appUrl}/hooks/connect`, { method: "POST", headers: { authorization: `Bearer ${eventToken}` } });
  const deliveryBody = await delivery.json();
  if (delivery.status !== 202 || deliveryBody.runtime !== "fail-closed" || deliveryBody.runs.length !== 0) throw new Error(`Event admission did not fail closed: ${JSON.stringify(deliveryBody)}`);
  const duplicate = await fetch(`${appUrl}/hooks/connect`, { method: "POST", headers: { authorization: `Bearer ${eventToken}` } });
  if (duplicate.status !== 200 || !(await duplicate.json()).duplicate) throw new Error("Event deduplication failed");
  const missingApi = await fetch(`${appUrl}/api/does-not-exist`);
  if (missingApi.status !== 404 || !missingApi.headers.get("content-type")?.includes("application/json")) throw new Error("Unknown API route fell through to SPA assets");

  chrome = spawn(chromeBinary, ["--headless=new", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(temporary, "chrome")}`, "about:blank"], { detached: true, stdio: "ignore" });
  let target;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) { target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" })).json(); break; } } catch {}
    await sleep(100);
  }
  if (!target) throw new Error("Chrome DevTools did not start");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => { socket.onopen = resolvePromise; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  const exceptions = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { const [resolvePromise, reject] = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolvePromise(message.result); }
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  };
  const command = (method, params = {}) => new Promise((resolvePromise, reject) => { const id = ++sequence; pending.set(id, [resolvePromise, reject]); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
  const waitFor = async (expression, label) => {
    for (let attempt = 0; attempt < 80; attempt += 1) { if (await evaluate(expression)) return; await sleep(100); }
    throw new Error(`Timed out waiting for ${label}: ${await evaluate("document.body.innerText.slice(0,1200)")}`);
  };
  const shot = async (path) => { const image = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); await writeFile(path, Buffer.from(image.data, "base64")); };
  const require = createRequire(join(appDirectory, "package.json"));
  const axePackage = require.resolve("@axe-core/playwright");
  const axeModules = dirname(dirname(dirname(dirname(axePackage))));
  const axeSource = await readFile(join(axeModules, "axe-core", "axe.min.js"), "utf8").catch(() => null);
  if (!axeSource) throw new Error("Unable to load the pinned Axe runtime");
  const seriousViolations = [];
  const visit = async (path, title, destination) => {
    await command("Page.navigate", { url: `${appUrl}${path}` });
    await waitFor(`document.querySelector('h1')?.textContent === ${JSON.stringify(title)}`, `${title} page`);
    await sleep(120);
    await evaluate(axeSource);
    const violations = await evaluate(`axe.run(document,{resultTypes:['violations']}).then((r)=>r.violations.filter((v)=>['serious','critical'].includes(v.impact)).map((v)=>({id:v.id,nodes:v.nodes.slice(0,4).map((n)=>({target:n.target,html:n.html,failure:n.failureSummary}))})))`);
    seriousViolations.push(...violations.map((violation) => ({ page: title, ...violation })));
    await shot(destination);
  };
  await command("Runtime.enable"); await command("Page.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await visit("/inbox", "Inbox", screenshots.inbox);
  await visit("/agents", "Agents", screenshots.agents);
  await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab" });
  await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab" });
  if (!await evaluate("document.activeElement !== document.body")) throw new Error("Keyboard focus did not enter the Agents page");
  await evaluate("localStorage.setItem('gardener.theme','light')");
  await visit(`/agents/${agentId}`, "Smoke issue gardener", screenshots["agent-light"]);
  if (!await evaluate("document.documentElement.dataset.mode === 'light'")) throw new Error("Light theme did not apply");
  await evaluate("localStorage.setItem('gardener.theme','dark')");
  await visit(`/agents/${agentId}`, "Smoke issue gardener", screenshots["agent-dark"]);
  if (!await evaluate("document.documentElement.dataset.mode === 'dark'")) throw new Error("Dark theme did not apply");
  await visit("/history", "History", screenshots.history);
  await visit("/policies", "Policies", screenshots.policies);
  await visit("/settings", "Settings", screenshots.settings);
  const runtimeReady = await evaluate(`([...document.querySelectorAll('.health-row')].find((row)=>row.textContent.includes('Durable orchestration'))?.textContent)||''`);
  if (!runtimeReady.includes("Unavailable") || !runtimeReady.toLowerCase().includes("fail closed")) throw new Error(`Settings hid fail-closed runtime: ${runtimeReady}`);
  await command("Emulation.setDeviceMetricsOverride", { width: 720, height: 900, deviceScaleFactor: 1, mobile: false });
  await visit(`/agents/${agentId}/draft`, "Edit Smoke issue gardener", screenshots["editor-zoom"]);
  if (!await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")) throw new Error("Agent editor fails 200% reflow");
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await visit(`/agents/${agentId}/draft`, "Edit Smoke issue gardener", screenshots["editor-mobile"]);
  if (!await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")) throw new Error("Agent editor overflows mobile viewport");

  if (seriousViolations.length) throw new Error(`Axe serious violations: ${JSON.stringify(seriousViolations)}`);
  if (exceptions.length) throw new Error(`Browser exceptions: ${JSON.stringify(exceptions)}`);

  const health = (await json("/api/health")).body;
  const history = (await json("/api/history")).body;
  const result = {
    passed: true,
    agent: { id: agentId, enabled: detail.agent.enabled, activeRevision: detail.agent.activeRevision, latestRevision: detail.agent.latestRevision },
    runtime: health.agentRuntime,
    event: { accepted: delivery.status === 202, duplicate: true, runsStarted: deliveryBody.runs.length },
    connectRequests,
    historyItems: history.items.length,
    axeSeriousViolations: seriousViolations,
    screenshots,
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  socket?.close();
  await stop(chrome);
  await stop(worker);
  if (connect.listening) await close(connect);
  if (priorDevVars !== undefined) await writeFile(devVars, priorDevVars, { mode: 0o600 }); else await rm(devVars, { force: true });
  if (process.env.KEEP_SMOKE_ARTIFACTS !== "true") await rm(temporary, { recursive: true, force: true });
}
