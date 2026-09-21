/// <reference types="node" />
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  completeProviderLogin,
  activePrincipalBySubject,
  consumeProviderLogin,
  dashboardSessionPayload,
  ensureCloudflareAccessOwner,
  IdentityExchangeError,
  issueDashboardSession,
  resolveDashboardSession,
} from "../src/identity";
import {
  compareAndSetOperationPolicies,
  policyMutationPermission,
  resolveMcpAuthorization,
  resolveRequestAuthorization,
} from "../src/authorization";
import type { Env } from "../src/env";
import type { GardenerMcpPrincipal } from "../src/mcp/services";
import { d1Database } from "./persistence-test-db";

beforeAll(() => {
  if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
});

const migration = (name: string) =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration("0001_initial.sql"));
  sqlite.exec("INSERT INTO gardener_schema(singleton,version)VALUES(1,4)");
  sqlite.exec(migration("0005_agent_runtime_admission.sql"));
  sqlite.exec(migration("0006_flue_harness_requests.sql"));
  sqlite.exec(migration("0007_team_workspace_foundation.sql"));
  sqlite.exec(migration("0008_flue_native_runtime.sql"));
  return { sqlite, db: d1Database(sqlite) };
}

function seedOwner(sqlite: DatabaseSync, subject = "101", login = "owner"): void {
  sqlite.prepare("INSERT INTO users(id,display_name)VALUES(?,?)")
    .run(`user_github_${subject}`, login);
  sqlite.prepare(
    "INSERT INTO external_identities(id,user_id,provider,provider_subject,username) " +
    "VALUES(?,?,'github',?,?)",
  ).run(`identity_github_${subject}`, `user_github_${subject}`, subject, login);
  sqlite.prepare(
    "INSERT INTO memberships(id,user_id,role,permanent) VALUES(?,?,'owner',1)",
  ).run(`membership_github_${subject}`, `user_github_${subject}`);
}

function login(subject: string, handoffId: string, username = `user-${subject}`) {
  return {
    handoffId,
    identity: { provider: "github" as const, subject, login: username },
    expiresAt: 4_000_000_000,
  };
}

describe("Gateway identity handoffs and opaque sessions", () => {
  it("classifies policy narrowing and widening", () => {
    expect(policyMutationPermission("automatic", "approval")).toBe("policy.narrow");
    expect(policyMutationPermission("disabled", "approval")).toBe("policy.widen");
    expect(policyMutationPermission("approval", "approval", { b: 2, a: 1 }, { a: 1, b: 2 }))
      .toBe("policy.narrow");
    expect(policyMutationPermission("approval", "approval", { a: 1 }, { a: 2 }))
      .toBe("policy.widen");
  });

  it("compare-and-sets policy modes and rolls back stale mixed batches", async () => {
    const { sqlite, db } = database();
    try {
      sqlite.prepare(
        "UPDATE operation_policies SET mode='automatic' WHERE operation_kind='issue.comment.create'",
      ).run();
      sqlite.prepare("UPDATE operation_policies SET mode='approval' WHERE operation_kind='issue.close'")
        .run();
      const audit = {
        actor: "Owner",
        actorUserId: null,
        actorIdentityJson: '{"provider":"github","providerSubject":"101","login":"owner"}',
      };
      await expect(compareAndSetOperationPolicies(db, [{
        operation: "issue.comment.create",
        expectedMode: "automatic",
        nextMode: "approval",
      }], audit)).resolves.toBe("updated");
      await expect(compareAndSetOperationPolicies(db, [
        { operation: "issue.comment.create", expectedMode: "approval", nextMode: "disabled" },
        { operation: "issue.close", expectedMode: "automatic", nextMode: "disabled" },
      ], audit)).resolves.toBe("conflict");
      expect(sqlite.prepare(
        "SELECT mode FROM operation_policies WHERE operation_kind='issue.comment.create'",
      ).get()).toEqual({ mode: "approval" });
    } finally { sqlite.close(); }
  });

  it("admits only a preseeded owner and consumes each handoff once", async () => {
    const { sqlite, db } = database();
    try {
      seedOwner(sqlite);
      const ownerLogin = login("101", "login_owner_1234567890", "renamed-owner");
      await completeProviderLogin(db, ownerLogin);
      const owner = await consumeProviderLogin(db, ownerLogin.handoffId);
      expect(owner).toMatchObject({ role: "owner", permanent: true });
      expect(dashboardSessionPayload(owner)).toMatchObject({
        authenticated: true,
        githubLogin: "renamed-owner",
        user: { role: "owner", identity: { providerSubject: "101" } },
      });
      await expect(consumeProviderLogin(db, ownerLogin.handoffId)).rejects.toMatchObject({
        code: "identity_handoff_replayed",
      } satisfies Partial<IdentityExchangeError>);
      await expect(completeProviderLogin(
        db,
        login("202", "login_unknown_1234567890"),
      )).rejects.toMatchObject({ code: "identity_not_authorized" });
      expect(sqlite.prepare("SELECT COUNT(*) count FROM memberships WHERE role='owner'").get())
        .toEqual({ count: 1 });
    } finally { sqlite.close(); }
  });

  it("accepts invitations by immutable numeric subject while usernames change", async () => {
    const { sqlite, db } = database();
    try {
      seedOwner(sqlite);
      sqlite.prepare(
        "INSERT INTO invitations(id,provider,provider_subject,username,invited_by_user_id) " +
        "VALUES('invite-1','github','202','old-login','user_github_101')",
      ).run();
      const memberLogin = login("202", "login_member_1234567890", "new-login");
      await completeProviderLogin(db, memberLogin);
      const member = await consumeProviderLogin(db, memberLogin.handoffId);
      expect(member).toMatchObject({ role: "member", identity: { login: "new-login" } });
      expect(sqlite.prepare(
        "SELECT status,accepted_by_user_id FROM invitations WHERE id='invite-1'",
      ).get()).toEqual({ status: "accepted", accepted_by_user_id: member.userId });
      await expect(completeProviderLogin(
        db,
        login("303", "login_recycled_1234567890", "old-login"),
      )).rejects.toMatchObject({ code: "identity_not_authorized" });
    } finally { sqlite.close(); }
  });

  it("stores only a session hash and expires or revokes it", async () => {
    const { sqlite, db } = database();
    try {
      seedOwner(sqlite);
      const ownerLogin = login("101", "login_session_1234567890", "owner");
      await completeProviderLogin(db, ownerLogin);
      const principal = await consumeProviderLogin(db, ownerLogin.handoffId);
      const issued = await issueDashboardSession(db, principal, true, 1_000);
      expect(issued.cookieName).toBe("__Host-gardener_session");
      expect(sqlite.prepare("SELECT token_hash FROM dashboard_sessions").get())
        .not.toEqual({ token_hash: issued.token });
      expect(await resolveDashboardSession(db, issued.token, 1_400)).not.toBeNull();
      expect(await resolveDashboardSession(db, issued.token, 5_000)).toBeNull();
    } finally { sqlite.close(); }
  });

  it("re-resolves MCP tokens to the current owner", async () => {
    const { sqlite, db } = database();
    try {
      seedOwner(sqlite);
      const token = (subject: string, workspace = "workspace-1"): GardenerMcpPrincipal => ({
        clientId: "client",
        audience: "https://gardener.test/mcp",
        grantedScopes: [],
        owner: { githubUserId: subject, githubLogin: "stale", instanceId: workspace },
      });
      await expect(resolveMcpAuthorization(db, "workspace-1", token("101"))).resolves
        .toMatchObject({ role: "owner", principalKind: "mcp-token" });
      await expect(resolveMcpAuthorization(db, "workspace-1", token("101", "wrong")))
        .resolves.toBeNull();
      await expect(resolveMcpAuthorization(db, "workspace-1", token("202")))
        .resolves.toBeNull();
    } finally { sqlite.close(); }
  });
});

describe("Cloudflare Access owner binding", () => {
  const accessIdentity = {
    subject: "access-subject-1",
    email: "owner@example.com",
    issuer: "https://example.cloudflareaccess.com",
  };

  it("bootstraps the permanent owner when the workspace has no owner", async () => {
    const { sqlite, db } = database();
    try {
      const owner = await ensureCloudflareAccessOwner(db, accessIdentity);
      expect(owner).toMatchObject({
        role: "owner",
        permanent: true,
        identity: {
          provider: "cloudflare-access",
          providerSubject: accessIdentity.subject,
          login: accessIdentity.email,
        },
      });
      await expect(ensureCloudflareAccessOwner(db, accessIdentity)).resolves.toEqual(owner);
      expect(sqlite.prepare("SELECT COUNT(*) count FROM memberships WHERE role='owner'").get())
        .toEqual({ count: 1 });
    } finally { sqlite.close(); }
  });

  it("links Access identity to an existing permanent owner", async () => {
    const { sqlite, db } = database();
    try {
      seedOwner(sqlite);
      const owner = await ensureCloudflareAccessOwner(db, accessIdentity);
      expect(owner).toMatchObject({
        userId: "user_github_101",
        role: "owner",
        identity: { provider: "cloudflare-access", login: accessIdentity.email },
      });
      expect(sqlite.prepare(
        "SELECT user_id FROM external_identities WHERE provider='cloudflare-access'",
      ).get()).toEqual({ user_id: "user_github_101" });
      expect(sqlite.prepare("SELECT COUNT(*) count FROM memberships WHERE role='owner'").get())
        .toEqual({ count: 1 });
    } finally { sqlite.close(); }
  });

  it("prefers a verified Access identity over an existing dashboard cookie", async () => {
    const { sqlite, db } = database();
    try {
      seedOwner(sqlite);
      const githubOwner = await activePrincipalBySubject(db, "101");
      expect(githubOwner).not.toBeNull();
      const session = await issueDashboardSession(db, githubOwner!, false);
      const request = new Request("https://gardener.example.test/api/state", {
        headers: { cookie: `${session.cookieName}=${session.token}` },
      });
      const principal = await resolveRequestAuthorization(
        request,
        { DB: db, LOCAL_DEV_BYPASS: "false" } as Env,
        async () => accessIdentity,
      );
      expect(principal).toMatchObject({
        userId: "user_github_101",
        principalKind: "cloudflare-access",
        identity: { provider: "cloudflare-access", providerSubject: accessIdentity.subject },
      });
    } finally { sqlite.close(); }
  });

  it("rejects an Access subject linked to a non-owner membership", async () => {
    const { sqlite, db } = database();
    try {
      seedOwner(sqlite);
      sqlite.exec(
        "INSERT INTO users(id,display_name)VALUES('access-member','Access member');" +
        "INSERT INTO external_identities(id,user_id,provider,provider_subject,username)" +
        "VALUES('access-member-identity','access-member','cloudflare-access','access-subject-1','owner@example.com');" +
        "INSERT INTO memberships(id,user_id,role,permanent)" +
        "VALUES('access-member-membership','access-member','member',0);",
      );
      await expect(ensureCloudflareAccessOwner(db, accessIdentity)).rejects.toMatchObject({
        code: "identity_not_authorized",
      } satisfies Partial<IdentityExchangeError>);
      await expect(resolveRequestAuthorization(
        new Request("https://gardener.example.test/api/state"),
        { DB: db, LOCAL_DEV_BYPASS: "false" } as Env,
        async () => accessIdentity,
      )).resolves.toBeNull();
    } finally { sqlite.close(); }
  });
});
