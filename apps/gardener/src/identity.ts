import type { WorkspaceRole } from "@gardener/contracts";
import {
  completeGitHubLoginSchema,
  type CompleteGitHubLogin,
} from "@gardener/provider-github";

export const SESSION_IDLE_TTL_SECONDS = 30 * 60;
export const SESSION_ABSOLUTE_TTL_SECONDS = 8 * 60 * 60;
export const SESSION_REFRESH_INTERVAL_SECONDS = 5 * 60;
export const INVITATION_TTL_SECONDS = 14 * 24 * 60 * 60;
export const SECURE_SESSION_COOKIE = "__Host-gardener_session";
export const LOCAL_SESSION_COOKIE = "gardener_session";

export interface IdentitySnapshot {
  provider: "github" | "cloudflare-access";
  providerSubject: string;
  login: string;
}

export interface ActivePrincipalRecord {
  userId: string;
  displayName: string;
  role: WorkspaceRole;
  permanent: boolean;
  identity: IdentitySnapshot;
}

export function dashboardSessionPayload(
  principal: Pick<ActivePrincipalRecord, "userId" | "displayName" | "role" | "identity">,
){
  return {authenticated:true as const,githubLogin:principal.identity.login,user:{id:principal.userId,displayName:principal.displayName,role:principal.role,identity:principal.identity}};
}

export interface DashboardSession extends ActivePrincipalRecord {
  tokenHash: string;
  cookieName: typeof SECURE_SESSION_COOKIE | typeof LOCAL_SESSION_COOKIE;
}

export class IdentityExchangeError extends Error {
  constructor(readonly code: "identity_handoff_replayed" | "identity_not_authorized") {
    super(code);
  }
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomOpaqueToken(): string {
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function ids(subject: string) {
  return { userId: `user_github_${subject}`, identityId: `identity_github_${subject}`, membershipId: `membership_github_${subject}` };
}

export async function completeProviderLogin(
  db: D1Database,
  inputValue: CompleteGitHubLogin,
): Promise<void> {
  const input = completeGitHubLoginSchema.parse(inputValue);
  const existing = await activePrincipalBySubject(db, input.identity.subject);
  const invitation = await db.prepare(
    "SELECT 1 FROM invitations WHERE provider = 'github' AND provider_subject = ? " +
    "AND status = 'pending' AND created_at >= datetime('now', ?) LIMIT 1",
  ).bind(input.identity.subject, `-${INVITATION_TTL_SECONDS} seconds`).first();
  if (!existing && !invitation) throw new IdentityExchangeError("identity_not_authorized");

  const handoffHash = await sha256(input.handoffId);
  const inserted = await db.prepare(
    "INSERT INTO provider_login_handoffs " +
    "(handoff_hash, provider, provider_subject, username, expires_at) " +
    "VALUES (?, 'github', ?, ?, ?) ON CONFLICT(handoff_hash) DO NOTHING",
  ).bind(handoffHash, input.identity.subject, input.identity.login, input.expiresAt).run();
  if ((inserted.meta.changes ?? 0) === 1) return;

  const prior = await db.prepare(
    "SELECT provider_subject, username, expires_at FROM provider_login_handoffs " +
    "WHERE handoff_hash = ?",
  ).bind(handoffHash).first<{ provider_subject: string; username: string; expires_at: number }>();
  if (
    !prior ||
    prior.provider_subject !== input.identity.subject ||
    prior.username !== input.identity.login ||
    prior.expires_at !== input.expiresAt
  ) {
    throw new IdentityExchangeError("identity_handoff_replayed");
  }
}

export async function consumeProviderLogin(
  db: D1Database,
  handoffId: string,
): Promise<ActivePrincipalRecord> {
  const handoffHash = await sha256(handoffId);
  const handoff = await db.prepare(
    "SELECT provider_subject, username, expires_at, consumed_at FROM provider_login_handoffs " +
    "WHERE handoff_hash = ?",
  ).bind(handoffHash).first<{
    provider_subject: string;
    username: string;
    expires_at: number;
    consumed_at: string | null;
  }>();
  if (!handoff || handoff.expires_at < Math.floor(Date.now() / 1_000)) {
    throw new IdentityExchangeError("identity_not_authorized");
  }
  if (handoff.consumed_at) throw new IdentityExchangeError("identity_handoff_replayed");

  const generated = ids(handoff.provider_subject);
  const linked = await db.prepare(
    "SELECT user_id FROM external_identities WHERE provider = 'github' AND provider_subject = ?",
  ).bind(handoff.provider_subject).first<{ user_id: string }>();
  const userId = linked?.user_id ?? generated.userId;
  const existingMembership = linked
    ? await db.prepare("SELECT 1 FROM memberships WHERE user_id = ?").bind(linked.user_id).first()
    : null;
  const invitation = await db.prepare(
    "SELECT 1 FROM invitations WHERE provider = 'github' AND provider_subject = ? " +
    "AND status = 'pending' AND created_at >= datetime('now', ?) LIMIT 1",
  ).bind(handoff.provider_subject, `-${INVITATION_TTL_SECONDS} seconds`).first();
  if (!existingMembership && !invitation) throw new IdentityExchangeError("identity_not_authorized");

  const consumed = await db.prepare(
    "UPDATE provider_login_handoffs SET consumed_at = CURRENT_TIMESTAMP " +
    "WHERE handoff_hash = ? AND consumed_at IS NULL AND expires_at >= ?",
  ).bind(handoffHash, Math.floor(Date.now() / 1_000)).run();
  if ((consumed.meta.changes ?? 0) !== 1) {
    throw new IdentityExchangeError("identity_handoff_replayed");
  }

  const profile = JSON.stringify({ login: handoff.username });
  const actorIdentity = JSON.stringify({
    provider: "github",
    providerSubject: handoff.provider_subject,
    login: handoff.username,
  });
  await db.batch([
    db.prepare(
      "INSERT INTO users (id, display_name) VALUES (?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, updated_at = CURRENT_TIMESTAMP",
    ).bind(userId, handoff.username),
    db.prepare(
      "INSERT INTO external_identities " +
      "(id, user_id, provider, provider_subject, username, profile_json) " +
      "VALUES (?, ?, 'github', ?, ?, ?) " +
      "ON CONFLICT(provider, provider_subject) DO UPDATE SET " +
      "username = excluded.username, profile_json = excluded.profile_json",
    ).bind(
      generated.identityId,
      userId,
      handoff.provider_subject,
      handoff.username,
      profile,
    ),
    db.prepare(
      "INSERT INTO memberships (id, user_id, role, permanent, created_by_user_id) " +
      "SELECT ?, ?, 'member', 0, i.invited_by_user_id FROM invitations i " +
      "WHERE i.provider = 'github' AND i.provider_subject = ? AND i.status = 'pending' " +
      "AND i.created_at >= datetime('now', ?) ORDER BY i.created_at, i.id LIMIT 1 " +
      "ON CONFLICT(user_id) DO NOTHING",
    ).bind(
      generated.membershipId,
      userId,
      handoff.provider_subject,
      `-${INVITATION_TTL_SECONDS} seconds`,
    ),
    db.prepare(
      "UPDATE invitations SET status = 'accepted', accepted_by_user_id = ?, " +
      "accepted_at = CURRENT_TIMESTAMP WHERE provider = 'github' AND provider_subject = ? " +
      "AND status = 'pending' AND created_at >= datetime('now', ?) " +
      "AND EXISTS (SELECT 1 FROM memberships WHERE user_id = ?)",
    ).bind(
      userId,
      handoff.provider_subject,
      `-${INVITATION_TTL_SECONDS} seconds`,
      userId,
    ),
    db.prepare(
      "INSERT OR IGNORE INTO audit_records " +
      "(actor, actor_user_id, actor_identity_json, action, resource_type, resource_id, detail_json) " +
      "SELECT ?, ?, ?, 'membership.invitation_accepted', 'invitation', id, " +
      "json_object('role', 'member') FROM invitations WHERE provider = 'github' " +
      "AND provider_subject = ? AND status = 'accepted' AND accepted_by_user_id = ?",
    ).bind(
      handoff.username,
      userId,
      actorIdentity,
      handoff.provider_subject,
      userId,
    ),
  ]);

  const principal = await activePrincipalBySubject(db, handoff.provider_subject);
  if (!principal) throw new IdentityExchangeError("identity_not_authorized");
  return principal;
}

export async function activePrincipalBySubject(db: D1Database, subject: string): Promise<ActivePrincipalRecord | null> {
  const row = await db.prepare("SELECT u.id user_id, u.display_name, m.role, m.permanent, e.provider_subject, e.username FROM external_identities e JOIN users u ON u.id = e.user_id JOIN memberships m ON m.user_id = u.id WHERE e.provider = 'github' AND e.provider_subject = ?")
    .bind(subject).first<{ user_id: string; display_name: string; role: WorkspaceRole; permanent: number; provider_subject: string; username: string | null }>();
  return row ? { userId: row.user_id, displayName: row.display_name, role: row.role, permanent: Boolean(row.permanent), identity: { provider: "github", providerSubject: row.provider_subject, login: row.username ?? row.display_name } } : null;
}

export async function ensureCloudflareAccessOwner(
  db: D1Database,
  identity: { subject: string; email: string; issuer: string },
): Promise<ActivePrincipalRecord> {
  const existing = await activeCloudflareAccessPrincipal(db, identity.subject);
  if (existing && existing.role !== "owner") {
    throw new IdentityExchangeError("identity_not_authorized");
  }
  if (existing) {
    await db.prepare(
      "UPDATE external_identities SET username=?,profile_json=? " +
      "WHERE provider='cloudflare-access' AND provider_subject=?",
    ).bind(
      identity.email,
      JSON.stringify({ email: identity.email, issuer: identity.issuer }),
      identity.subject,
    ).run();
    return { ...existing, displayName: identity.email, identity: { ...existing.identity, login: identity.email } };
  }

  const owner = await db.prepare(
    "SELECT u.id user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.role='owner' LIMIT 1",
  ).first<{ user_id: string }>();
  const digest = await sha256(`${identity.issuer}|${identity.subject}`);
  const userId = owner?.user_id ?? `user_access_${digest}`;
  const identityId = `identity_access_${digest}`;
  const profile = JSON.stringify({ email: identity.email, issuer: identity.issuer });

  if (owner) {
    await db.prepare(
      "INSERT INTO external_identities (id,user_id,provider,provider_subject,username,profile_json) " +
      "VALUES (?,?,'cloudflare-access',?,?,?) " +
      "ON CONFLICT(provider,provider_subject) DO UPDATE SET username=excluded.username,profile_json=excluded.profile_json",
    ).bind(identityId, userId, identity.subject, identity.email, profile).run();
  } else {
    await db.batch([
      db.prepare("INSERT INTO users(id,display_name) VALUES(?,?)").bind(userId, identity.email),
      db.prepare(
        "INSERT INTO external_identities (id,user_id,provider,provider_subject,username,profile_json) " +
        "VALUES (?,?,'cloudflare-access',?,?,?)",
      ).bind(identityId, userId, identity.subject, identity.email, profile),
      db.prepare(
        "INSERT INTO memberships(id,user_id,role,permanent) VALUES(?,?,'owner',1)",
      ).bind(`membership_access_${digest}`, userId),
    ]);
  }

  const principal = await activeCloudflareAccessPrincipal(db, identity.subject);
  if (!principal || principal.role !== "owner") {
    throw new IdentityExchangeError("identity_not_authorized");
  }
  return principal;
}

async function activeCloudflareAccessPrincipal(
  db: D1Database,
  subject: string,
): Promise<ActivePrincipalRecord | null> {
  const row = await db.prepare(
    "SELECT u.id user_id,u.display_name,m.role,m.permanent,e.provider_subject,e.username " +
    "FROM external_identities e JOIN users u ON u.id=e.user_id JOIN memberships m ON m.user_id=u.id " +
    "WHERE e.provider='cloudflare-access' AND e.provider_subject=?",
  ).bind(subject).first<{
    user_id: string;
    display_name: string;
    role: WorkspaceRole;
    permanent: number;
    provider_subject: string;
    username: string | null;
  }>();
  return row ? {
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role,
    permanent: Boolean(row.permanent),
    identity: {
      provider: "cloudflare-access",
      providerSubject: row.provider_subject,
      login: row.username ?? row.display_name,
    },
  } : null;
}

export async function issueDashboardSession(db: D1Database, principal: ActivePrincipalRecord, secure: boolean, now = Math.floor(Date.now() / 1000)): Promise<{ token: string; cookieName: DashboardSession["cookieName"]; maxAge: number }> {
  const token = randomOpaqueToken(); const csrf = randomOpaqueToken();
  const cookieName = secure ? SECURE_SESSION_COOKIE : LOCAL_SESSION_COOKIE;
  await db.prepare("INSERT INTO dashboard_sessions (token_hash, user_id, csrf_digest, cookie_name, idle_expires_at, absolute_expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, datetime(?, 'unixepoch'), datetime(?, 'unixepoch'))")
    .bind(await sha256(token), principal.userId, await sha256(csrf), cookieName, now + SESSION_IDLE_TTL_SECONDS, now + SESSION_ABSOLUTE_TTL_SECONDS, now, now).run();
  return { token, cookieName, maxAge: SESSION_IDLE_TTL_SECONDS };
}

export async function resolveDashboardSession(db: D1Database, token: string, now = Math.floor(Date.now() / 1000)): Promise<DashboardSession | null> {
  const tokenHash = await sha256(token);
  const row = await db.prepare("SELECT s.token_hash, s.cookie_name, s.idle_expires_at, s.absolute_expires_at, unixepoch(s.last_seen_at) last_seen, u.id user_id, u.display_name, m.role, m.permanent, e.provider_subject, e.username FROM dashboard_sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=u.id JOIN external_identities e ON e.user_id=u.id AND e.provider='github' WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.idle_expires_at > ? AND s.absolute_expires_at > ?")
    .bind(tokenHash, now, now).first<{ token_hash:string; cookie_name:DashboardSession["cookieName"]; idle_expires_at:number; absolute_expires_at:number; last_seen:number; user_id:string; display_name:string; role:WorkspaceRole; permanent:number; provider_subject:string; username:string|null }>();
  if (!row) return null;
  if (now - row.last_seen >= SESSION_REFRESH_INTERVAL_SECONDS) {
    const idle = Math.min(now + SESSION_IDLE_TTL_SECONDS, row.absolute_expires_at);
    await db.prepare("UPDATE dashboard_sessions SET last_seen_at=datetime(?, 'unixepoch'), idle_expires_at=? WHERE token_hash=? AND revoked_at IS NULL AND last_seen_at <= datetime(?, 'unixepoch')")
      .bind(now, idle, tokenHash, now - SESSION_REFRESH_INTERVAL_SECONDS).run();
  }
  return { tokenHash, cookieName: row.cookie_name, userId: row.user_id, displayName: row.display_name, role: row.role, permanent: Boolean(row.permanent), identity: { provider:"github", providerSubject:row.provider_subject, login:row.username ?? row.display_name } };
}

export async function revokeDashboardSession(db: D1Database, token: string): Promise<void> {
  await db.prepare("UPDATE dashboard_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE token_hash=? AND revoked_at IS NULL").bind(await sha256(token)).run();
}

export function sessionTokenFromRequest(request: Request): string | null {
  const raw=request.headers.get("cookie"); if (!raw) return null; const values=new Map<string,string>();
  for (const part of raw.split(";")) { const i=part.indexOf("="); if(i>=0) values.set(part.slice(0,i).trim(), part.slice(i+1).trim()); }
  return values.get(SECURE_SESSION_COOKIE) ?? values.get(LOCAL_SESSION_COOKIE) ?? null;
}
