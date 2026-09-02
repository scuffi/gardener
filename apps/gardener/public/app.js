const sessionKey = "gardener.identity";
const returned = new URLSearchParams(location.hash.slice(1)).get("identity_token") || new URLSearchParams(location.hash.slice(1)).get("token");
if (returned) {
  sessionStorage.setItem(sessionKey, returned);
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const when = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(`${value}Z`.replace("ZZ", "Z"))) : "—";

let state = null;
let health = null;
let selectedProfile = "safe";
let noticeTimer;

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path, options = {}) {
  const token = sessionStorage.getItem(sessionKey);
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error || `Request failed (${response.status})`, response.status);
  return body;
}

function notice(message, error = false) {
  clearTimeout(noticeTimer);
  $("#notice-copy").textContent = message;
  $("#notice-icon").textContent = error ? "!" : "✓";
  $("#notice").className = `notice${error ? " error" : ""}`;
  noticeTimer = setTimeout(() => $("#notice").classList.add("hidden"), 5200);
}

function navigate(id) {
  const target = document.getElementById(id) ? id : "overview";
  $$("nav a, .page").forEach((node) => node.classList.remove("active"));
  document.querySelector(`nav a[href="#${target}"]`)?.classList.add("active");
  document.getElementById(target)?.classList.add("active");
  const label = document.querySelector(`nav a[href="#${target}"]`)?.childNodes[1]?.textContent?.trim() || target[0].toUpperCase() + target.slice(1);
  $("#page-title").textContent = label;
  $("#breadcrumb").textContent = label;
  if (location.hash !== `#${target}`) history.replaceState(null, "", `${location.pathname}${location.search}#${target}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setBusy(button, busy, text) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = text || "Working…";
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

function statusPill(status) {
  const value = status || "unknown";
  const tone = ["completed", "executed"].includes(value) ? "good" : ["failed", "completed_with_errors"].includes(value) ? "bad" : "warn";
  return `<span class="pill ${tone}">${escapeHtml(value.replaceAll("_", " "))}</span>`;
}

function usageText(raw) {
  if (!raw) return "";
  try {
    const usage = typeof raw === "string" ? JSON.parse(raw) : raw;
    const tokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
    const cost = typeof usage.costUsd === "number" ? ` · $${usage.costUsd.toFixed(6)}` : "";
    return tokens ? `${usage.model || "Workers AI"} · ${tokens.toLocaleString()} tokens${cost}` : (usage.model || "");
  } catch { return ""; }
}

function renderRuns(runs, target) {
  const node = $(target);
  if (!runs.length) {
    node.className = "list empty-state";
    node.innerHTML = `<span class="empty-icon">↳</span><strong>Waiting for the first issue event</strong><p>Open or reopen an issue in a connected repository to see Gardener work.</p>`;
    return;
  }
  node.className = "list";
  node.innerHTML = runs.map((run) => `<article class="row">
    <div class="row-copy"><p class="eyebrow">${escapeHtml(run.action)} · ${when(run.created_at)}</p><h3>${escapeHtml(run.workflow_name)} on ${escapeHtml(run.owner)}/${escapeHtml(run.name)}</h3>
      <p>${escapeHtml(run.summary || "Gardener is processing this event.")}</p>
      ${usageText(run.usage) ? `<div class="detail">${escapeHtml(usageText(run.usage))}</div>` : ""}
      ${run.error ? `<div class="detail">${escapeHtml(run.error)}</div>` : ""}
    </div>${statusPill(run.status)}
  </article>`).join("");
}

const operationNames = {
  "issue.label.add": ["Add labels", "Apply a conventional label to an issue"],
  "issue.label.remove": ["Remove labels", "Remove a label that no longer fits"],
  "issue.comment.create": ["Post comments", "Create one bounded, helpful issue reply"],
  "issue.comment.update": ["Update comments", "Update only a Gardener-owned issue reply"],
  "issue.close": ["Close issues", "Change an open issue to closed"],
  "issue.reopen": ["Reopen issues", "Return a closed issue to open"],
};

function renderHealth() {
  if (!health) return;
  $("#connection-dot").className = `dot ${health.ok ? "good" : "bad"}`;
  $("#connection-label").textContent = health.ok ? "Deployment healthy" : "Setup needs attention";
  $("#health-grid").innerHTML = [
    ["Database", health.database], ["Queue", health.queue], ["Workers AI", health.workersAi], ["Gardener Connect", health.connectConfigured],
  ].map(([label, ok]) => `<article class="metric"><span>${label}</span><strong class="${ok ? "" : "bad"}">${ok ? "Ready" : "Missing"}</strong><small>${ok ? "Provisioned" : "Check configuration"}</small></article>`).join("");
}

function markSetupStep(active) {
  const order = ["account", "repositories", "activate"];
  const activeIndex = order.indexOf(active);
  $$(".setup-step").forEach((node) => {
    const index = order.indexOf(node.dataset.step);
    node.classList.toggle("done", active === "complete" || index < activeIndex);
    node.classList.toggle("active", index === activeIndex);
  });
  $$(".setup-steps > i").forEach((node, index) => node.classList.toggle("done", active === "complete" || index < activeIndex));
}

function renderSetup() {
  const authenticated = Boolean(state);
  const repositories = state?.setup?.activeRepositories || 0;
  const completed = Boolean(state?.setup?.completed);
  document.body.classList.toggle("setup-mode", !completed);
  $("#setup-guide").classList.toggle("hidden", completed);
  $("#operating-dashboard").classList.toggle("hidden", !completed);
  $("#sign-in-button").classList.toggle("hidden", authenticated);
  $("#user-chip").classList.toggle("hidden", !authenticated);
  $("#configure-button").classList.toggle("hidden", !authenticated || completed);
  $("#pause-button").classList.toggle("hidden", !completed);

  if (authenticated) {
    const login = state.viewer?.login || "GitHub user";
    $("#user-login").textContent = login;
    $("#user-avatar").textContent = login.slice(0, 1);
    $("#session-owner").textContent = `Signed in as ${login}`;
  }
  if (completed) { markSetupStep("complete"); return; }

  const primary = $("#setup-primary");
  $("#profile-picker").classList.add("hidden");
  $("#setup-assurance").classList.remove("hidden");
  $("#setup-secondary").classList.add("hidden");

  if (!authenticated) {
    markSetupStep("account");
    $("#setup-progress").textContent = "1 of 3";
    $("#setup-kicker").textContent = health?.ok ? "Deployment ready" : "Deployment detected";
    $("#setup-overline").textContent = "Step 1 · Your account";
    $("#setup-action-title").textContent = "Connect your GitHub identity";
    $("#setup-action-copy").textContent = "Confirm who owns this deployment. Gardener Connect returns a temporary session scoped only to this Worker.";
    primary.textContent = "Continue with GitHub";
    primary.dataset.action = "signin";
    return;
  }

  if (!repositories) {
    markSetupStep("repositories");
    $("#setup-progress").textContent = "2 of 3";
    $("#setup-kicker").textContent = `Welcome, ${state.viewer?.login || "gardener"}`;
    $("#setup-overline").textContent = "Step 2 · Repository access";
    $("#setup-action-title").textContent = "Choose repositories to tend";
    $("#setup-action-copy").textContent = "Install the shared Gardener GitHub App and select only the repositories you want. App credentials stay in Connect—not in your deployment.";
    primary.textContent = "Choose GitHub repositories ↗";
    primary.dataset.action = "install";
    return;
  }

  markSetupStep("activate");
  $("#setup-progress").textContent = "3 of 3";
  $("#setup-kicker").textContent = `${repositories} ${repositories === 1 ? "repository" : "repositories"} connected`;
  $("#setup-overline").textContent = "Step 3 · Automation profile";
  $("#setup-action-title").textContent = "How should Gardener begin?";
  $("#setup-action-copy").textContent = "Start with a thoughtful preset. You can tune every operation policy later, and issue state changes remain off in all presets.";
  $("#profile-picker").classList.remove("hidden");
  $("#setup-assurance").classList.add("hidden");
  primary.textContent = "Activate Gardener";
  primary.dataset.action = "activate";
}

function renderDashboard() {
  if (!state) return;
  const workflows = state.workflows || [];
  const runs = state.runs || [];
  const approvals = state.approvals || [];
  const repositories = state.repositories || [];
  $("#metric-repositories").textContent = repositories.filter((item) => item.active).length;
  $("#metric-workflows").textContent = workflows.filter((item) => item.enabled).length;
  $("#metric-runs").textContent = runs.length;
  $("#metric-approvals").textContent = approvals.length;
  $("#approval-count").textContent = approvals.length;

  const paused = state.globalPaused;
  $("#pause-button").disabled = false;
  $("#pause-button").textContent = paused ? "▶" : "Ⅱ";
  $("#pause-button").title = paused ? "Resume all activity" : "Pause all activity";
  $("#pause-button").setAttribute("aria-label", $("#pause-button").title);
  $("#hero-dot").className = `live-dot${paused ? " bad" : ""}`;
  $("#hero-kicker").textContent = paused ? "Paused safely" : "Live · listening for events";
  $("#hero-status").textContent = paused ? "Gardener is taking a break" : "Your repositories are being tended";
  $("#hero-copy").textContent = paused
    ? "Events remain traceable, but new runs and GitHub writes are stopped. Resume whenever you're ready."
    : "Incoming issue events flow through your selected automation profile and immutable safety checks.";

  renderRuns(runs.slice(0, 5), "#overview-runs");
  renderRuns(runs, "#run-list");

  const repositoryList = $("#repository-list");
  if (!repositories.length) {
    repositoryList.className = "card-grid empty-state";
    repositoryList.innerHTML = `<span class="empty-icon">⌘</span><strong>No repositories connected</strong><p>Select repositories through the shared Gardener GitHub App.</p>`;
  } else {
    repositoryList.className = "card-grid";
    repositoryList.innerHTML = repositories.map((repository) => `<article>
      <p class="eyebrow">GitHub repository</p><h2>${escapeHtml(repository.owner)}/${escapeHtml(repository.name)}</h2>
      <p class="section-copy">Issue events · scoped installation access</p>
      <span class="pill ${repository.active ? "good" : "bad"}">${repository.active ? "Connected" : "Access removed"}</span>
    </article>`).join("");
  }

  $("#workflow-list").innerHTML = workflows.map((workflow) => `<article class="row">
    <div class="row-copy"><p class="eyebrow">${escapeHtml(workflow.trigger_kind)} · version ${workflow.version}</p><h3>${escapeHtml(workflow.name)}</h3>
      <p>Classifies opened and reopened issues, then proposes bounded labels and helpful comments.</p></div>
    <button class="button ${workflow.enabled ? "secondary" : "glow"}" data-workflow="${escapeHtml(workflow.id)}" data-enabled="${workflow.enabled ? "false" : "true"}">${workflow.enabled ? "Disable" : "Enable workflow"}</button>
  </article>`).join("");

  const approvalList = $("#approval-list");
  if (!approvals.length) {
    approvalList.className = "list empty-state";
    approvalList.innerHTML = `<span class="empty-icon">✓</span><strong>You're all caught up</strong><p>Proposals that require a decision will appear here.</p>`;
  } else {
    approvalList.className = "list";
    approvalList.innerHTML = approvals.map((proposal) => {
      let detail = proposal.operation_kind;
      try { const operation = JSON.parse(proposal.operation); detail = operation.label || operation.body || operation.kind; } catch {}
      const title = operationNames[proposal.operation_kind]?.[0] || proposal.operation_kind;
      return `<article class="row"><div class="row-copy"><p class="eyebrow">${escapeHtml(proposal.owner)}/${escapeHtml(proposal.name)}</p><h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(proposal.rationale)}</p><div class="detail">${escapeHtml(detail)}</div></div>
        <div class="row-actions"><button class="button quiet" data-reject="${escapeHtml(proposal.id)}">Reject</button><button class="button glow" data-approve="${escapeHtml(proposal.id)}">Approve</button></div></article>`;
    }).join("");
  }

  $("#policy-list").innerHTML = state.policies.map((policy) => {
    const [name, description] = operationNames[policy.operation_kind] || [policy.operation_kind, "Control this operation"];
    return `<article class="row"><div class="row-copy"><h3>${escapeHtml(name)}</h3><p>${escapeHtml(description)}</p></div>
      <select data-policy="${escapeHtml(policy.operation_kind)}" aria-label="Policy for ${escapeHtml(name)}">
        ${[["disabled", "Off"], ["approval", "Require approval"], ["automatic", "Automatic"]].map(([mode, label]) => `<option value="${mode}" ${mode === policy.mode ? "selected" : ""}>${label}</option>`).join("")}
      </select></article>`;
  }).join("");
}

async function installRepositories(button) {
  try {
    setBusy(button, true, "Opening GitHub…");
    const { installationUrl } = await api("/api/install/start", { method: "POST" });
    location.href = installationUrl;
  } catch (error) {
    setBusy(button, false);
    notice(error.message, true);
  }
}

async function load() {
  document.body.classList.add("is-loading");
  try {
    health = await api("/api/health");
  } catch {
    health = { ok: false, database: false, queue: false, workersAi: false, connectConfigured: false, localDevelopment: false };
  }
  renderHealth();

  const hasToken = Boolean(sessionStorage.getItem(sessionKey));
  if (!hasToken && !health.localDevelopment) {
    state = null;
    renderSetup();
    document.body.classList.remove("is-loading");
    return;
  }
  try {
    if (new URLSearchParams(location.search).get("installation") === "complete" && hasToken) {
      await api("/api/repositories/sync", { method: "POST" });
      history.replaceState(null, "", `${location.pathname}#overview`);
      notice("Repository access connected. One last step.");
    }
    state = await api("/api/state");
    selectedProfile = state.setup?.profile || selectedProfile;
    renderSetup();
    renderDashboard();
  } catch (error) {
    if (error.status === 401) {
      if (hasToken) {
        sessionStorage.removeItem(sessionKey);
        notice("Your dashboard session expired. Continue with GitHub to reconnect.", true);
      }
      state = null;
      renderSetup();
    } else {
      notice(error.message, true);
    }
  } finally {
    document.body.classList.remove("is-loading");
  }
}

document.addEventListener("click", async (event) => {
  const nav = event.target.closest("nav a");
  const jump = event.target.closest("[data-navigate]");
  if (nav) { event.preventDefault(); navigate(nav.getAttribute("href").slice(1)); }
  if (jump) navigate(jump.dataset.navigate);

  const profile = event.target.closest("[data-profile]");
  if (profile) {
    selectedProfile = profile.dataset.profile;
    $$("[data-profile]").forEach((node) => {
      const selected = node.dataset.profile === selectedProfile;
      node.classList.toggle("selected", selected);
      node.setAttribute("aria-checked", String(selected));
    });
  }

  const workflow = event.target.closest("[data-workflow]");
  const approve = event.target.closest("[data-approve]");
  const reject = event.target.closest("[data-reject]");
  try {
    if (workflow) await api(`/api/workflows/${encodeURIComponent(workflow.dataset.workflow)}/status`, { method: "POST", body: JSON.stringify({ enabled: workflow.dataset.enabled === "true" }) });
    if (approve) await api(`/api/approvals/${encodeURIComponent(approve.dataset.approve)}/approve`, { method: "POST" });
    if (reject) await api(`/api/approvals/${encodeURIComponent(reject.dataset.reject)}/reject`, { method: "POST" });
    if (workflow || approve || reject) { notice(approve ? "Proposal approved and sent to Connect." : reject ? "Proposal rejected." : "Workflow updated."); await load(); }
  } catch (error) { notice(error.message, true); }
});

document.addEventListener("change", async (event) => {
  if (!event.target.matches("[data-policy]")) return;
  try {
    await api(`/api/policies/${encodeURIComponent(event.target.dataset.policy)}`, { method: "PUT", body: JSON.stringify({ mode: event.target.value }) });
    notice("Policy updated. New runs will use this setting.");
    await load();
  } catch (error) { notice(error.message, true); }
});

$("#setup-primary").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const action = button.dataset.action;
  if (action === "signin") { location.href = "/api/auth/start"; return; }
  if (action === "install") { await installRepositories(button); return; }
  if (action === "activate") {
    try {
      setBusy(button, true, "Activating safely…");
      await api("/api/setup/activate", { method: "POST", body: JSON.stringify({ profile: selectedProfile }) });
      await load();
      notice("Gardener is live. Your repositories are now being tended.");
    } catch (error) { notice(error.message, true); }
    finally { setBusy(button, false); }
  }
});

$("#configure-button").addEventListener("click", () => { navigate("overview"); $("#setup-guide").scrollIntoView({ behavior: "smooth" }); });
$("#hero-repositories").addEventListener("click", () => navigate("repositories"));
$("#hero-policies").addEventListener("click", () => navigate("policies"));
$("#pause-button").addEventListener("click", async () => {
  try {
    await api("/api/settings/pause", { method: "POST", body: JSON.stringify({ paused: !state.globalPaused }) });
    await load();
    notice(state.globalPaused ? "Gardener is paused. No new runs or writes will start." : "Gardener resumed.");
  } catch (error) { notice(error.message, true); }
});
$("#install-github").addEventListener("click", (event) => installRepositories(event.currentTarget));
$("#sync-repositories").addEventListener("click", async (event) => {
  try {
    setBusy(event.currentTarget, true, "Syncing…");
    const result = await api("/api/repositories/sync", { method: "POST" });
    notice(`${result.repositories.length} ${result.repositories.length === 1 ? "repository" : "repositories"} synchronized.`);
    await load();
  } catch (error) { notice(error.message, true); }
  finally { setBusy(event.currentTarget, false); }
});
$("#test-workers-ai").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    setBusy(button, true, "Testing hosted model…");
    const result = await api("/api/health/ai", { method: "POST" });
    const cost = typeof result.usage?.costUsd === "number" ? ` · $${result.usage.costUsd.toFixed(6)}` : "";
    notice(`Workers AI check passed${cost}.`);
  } catch (error) { notice(error.message, true); }
  finally { setBusy(button, false); }
});
$("#clear-session").addEventListener("click", () => { sessionStorage.removeItem(sessionKey); state = null; navigate("overview"); load(); });

navigate(location.hash.slice(1) || "overview");
load();
