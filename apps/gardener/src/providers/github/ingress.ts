import { WorkerEntrypoint } from "cloudflare:workers";
import { canonicalSha256 } from "@gardener/core";
import {
  GITHUB_GATEWAY_CONTRACT_VERSION,
  completeGitHubLoginResultSchema,
  completeGitHubLoginSchema,
  deliverGitHubEventResultSchema,
  deliverGitHubEventSchema,
  type CompleteGitHubLogin,
  type DeliverGitHubEvent,
  type GardenerGitHubIngressRpc,
  type RepositoryEventV2,
} from "@gardener/provider-github";
import type { Env } from "../../env";
import { instanceId } from "../../env";
import { completeProviderLogin } from "../../identity";
import { audit } from "../../instance-state";
import {
  admitRepositoryEvent,
  claimRepositoryEventAdmission,
  completeRepositoryEventAdmission,
  listRepositoryEventRunIds,
  releaseRepositoryEventAdmission,
} from "../../persistence";
import { admitAgentRunsForEvent } from "../../run-admission";

export class GardenerGitHubEntrypoint
  extends WorkerEntrypoint<Env>
  implements GardenerGitHubIngressRpc {
  async health() {
    let ready = false;
    try { await this.env.DB.prepare("SELECT 1").first(); ready = true; }
    catch { /* reported below */ }
    return {
      contractVersion: GITHUB_GATEWAY_CONTRACT_VERSION,
      ready,
      workspaceId: instanceId(this.env),
    };
  }

  async completeLogin(inputValue: CompleteGitHubLogin) {
    const input = completeGitHubLoginSchema.parse(inputValue);
    await completeProviderLogin(this.env.DB, input);
    return completeGitHubLoginResultSchema.parse({ accepted: true });
  }

  async deliverGitHubEvent(inputValue: DeliverGitHubEvent) {
    const input = deliverGitHubEventSchema.parse(inputValue);
    return deliverRepositoryEvent(this.env, input.event, input.eventHash);
  }
}

export async function deliverRepositoryEvent(
  env: Env,
  event: RepositoryEventV2,
  eventHash: string,
) {
  if (!("deliveryId" in event)) throw new Error("provider_event_required");
  if (event.instanceId !== instanceId(env)) throw new Error("event_workspace_mismatch");
  if (await canonicalSha256(event) !== eventHash) throw new Error("event_integrity_failed");

  await upsertEventRepository(env.DB, event);
  const resource = eventResource(event);
  const admitted = await admitRepositoryEvent(env.DB, {
    id: event.id,
    provider: "github",
    deliveryId: event.deliveryId,
    eventKind: event.kind,
    action: event.action,
    repositoryId: event.repository.id,
    resourceType: resource.type,
    resourceId: resource.id,
    actor: event.actor,
    resourceAuthor: event.resourceAuthor,
    facts: trustedEventFacts(event),
    envelope: event,
    envelopeHash: eventHash,
    occurredAt: event.occurredAt,
  });
  if (admitted.admitted) {
    await audit(
      env.DB,
      "github-gateway",
      "repository_event.received",
      "repository_event",
      event.id,
      { deliveryId: event.deliveryId, kind: event.kind, action: event.action },
    );
  }

  const admissionToken = crypto.randomUUID();
  const now = new Date();
  const claimed = await claimRepositoryEventAdmission(env.DB, {
    eventId: event.id,
    token: admissionToken,
    now: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
  });
  if (!claimed) {
    const runIds = await listRepositoryEventRunIds(env.DB, event.id);
    return deliverGitHubEventResultSchema.parse({
      accepted: true,
      duplicate: !admitted.admitted,
      runIds,
    });
  }

  try {
    const runs = await admitAgentRunsForEvent(env, admitted.event.envelope, admitted.event.envelopeHash);
    const completed = await completeRepositoryEventAdmission(env.DB, {
      eventId: event.id,
      token: admissionToken,
      now: new Date().toISOString(),
    });
    if (!completed) throw new Error("event_admission_lease_lost");
    return deliverGitHubEventResultSchema.parse({
      accepted: true,
      duplicate: !admitted.admitted,
      runIds: runs.map((run) => run.runId),
    });
  } catch (error) {
    await releaseRepositoryEventAdmission(env.DB, {
      eventId: event.id,
      token: admissionToken,
    });
    throw error;
  }
}

async function upsertEventRepository(db: D1Database, event: RepositoryEventV2): Promise<void> {
  await db.prepare(
    "INSERT INTO repositories " +
    "(id, installation_id, owner, name, default_branch, active, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP) " +
    "ON CONFLICT(id) DO UPDATE SET installation_id = excluded.installation_id, " +
    "owner = excluded.owner, name = excluded.name, default_branch = excluded.default_branch, " +
    "active = 1, updated_at = CURRENT_TIMESTAMP",
  ).bind(
    event.repository.id,
    event.repository.installationId,
    event.repository.owner,
    event.repository.name,
    event.repository.defaultBranch,
  ).run();
}

function eventResource(event: RepositoryEventV2): { type: string; id: string } {
  if ("comment" in event) return { type: "comment", id: event.comment.id };
  if ("review" in event) return { type: "review", id: event.review.id };
  if ("issue" in event) return { type: "issue", id: event.issue.id };
  if ("pullRequest" in event) return { type: "pull_request", id: event.pullRequest.id };
  if ("discussion" in event) return { type: "discussion", id: event.discussion.id };
  if ("checkRun" in event) return { type: "check_run", id: event.checkRun.id };
  if ("checkSuite" in event) return { type: "check_suite", id: event.checkSuite.id };
  if ("release" in event) return { type: "release", id: event.release.id };
  if ("push" in event) return { type: "push", id: event.push.after };
  if ("requestId" in event) return { type: "manual", id: event.requestId };
  return { type: "schedule", id: event.scheduleId };
}

function trustedEventFacts(event: RepositoryEventV2): Record<string, unknown> {
  if ("pullRequest" in event) {
    return {
      labels: event.pullRequest.labels,
      draft: event.pullRequest.draft,
      headSha: event.pullRequest.head.sha,
      baseRef: event.pullRequest.base.ref,
      baseSha: event.pullRequest.base.sha,
    };
  }
  if ("issue" in event) {
    return {
      labels: event.issue.labels,
      state: event.issue.state,
      updatedAt: event.issue.updatedAt,
    };
  }
  if ("discussion" in event) {
    return {
      labels: event.discussion.labels,
      state: event.discussion.state,
      answered: event.discussion.answered,
      updatedAt: event.discussion.updatedAt,
    };
  }
  return {};
}
