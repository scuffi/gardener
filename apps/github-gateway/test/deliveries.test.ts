/// <reference types="node" />
import { webcrypto } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  acceptGitHubWebhook,
  retryWebhookDelivery,
} from "../src/deliveries";
import type { Env } from "../src/env";
import { testDatabase } from "./d1";

const github = vi.hoisted(() => ({ discoverRepositories: vi.fn() }));
vi.mock("../src/github-client", async (original) => {
  const module = await original<typeof import("../src/github-client")>();
  return { ...module, discoverRepositories: github.discoverRepositories };
});

beforeAll(() => {
  if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
});
afterEach(() => vi.restoreAllMocks());

const payload = {
  action: "opened",
  sender: { id: 11, login: "actor", type: "User" },
  installation: { id: 7 },
  repository: {
    id: 9,
    name: "widgets",
    default_branch: "main",
    owner: { login: "acme" },
  },
  issue: {
    id: 21,
    number: 3,
    title: "A bug",
    body: "body",
    state: "open",
    locked: false,
    labels: [{ name: "bug" }],
    user: { id: 12, login: "author", type: "User" },
    updated_at: "2026-01-01T00:00:00Z",
    html_url: "https://github.com/acme/widgets/issues/3",
  },
};

async function signedRequest(
  body: string,
  deliveryId = "delivery-1",
  eventName = "issues",
): Promise<Request> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("webhook-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  ));
  const hex = [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://gateway.test/webhooks/github", {
    method: "POST",
    headers: {
      "x-github-delivery": deliveryId,
      "x-github-event": eventName,
      "x-hub-signature-256": `sha256=${hex}`,
      "content-type": "application/json",
    },
    body,
  });
}

function environment(
  db: D1Database,
  deliverGitHubEvent: NonNullable<Env["GARDENER"]>["deliverGitHubEvent"],
): Env {
  return {
    DB: db,
    GARDENER_WORKSPACE_ID: "workspace-1",
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    GARDENER: { deliverGitHubEvent } as Env["GARDENER"],
  } as Env;
}

async function seedInstallation(db: D1Database): Promise<void> {
  await db.prepare(
    "INSERT INTO installations(id,account_id,account_login,account_type) " +
    "VALUES('7','50','acme','Organization')",
  ).run();
}

describe("direct Gateway delivery", () => {
  it("durably accepts before one waitUntil RPC attempt", async () => {
    const { sqlite, db } = testDatabase();
    try {
      await seedInstallation(db);
      const deliverGitHubEvent = vi.fn().mockResolvedValue({
        accepted: true,
        duplicate: false,
        runIds: ["run-1"],
      });
      const env = environment(db, deliverGitHubEvent);
      let pending: Promise<unknown> | undefined;
      const result = await acceptGitHubWebhook(
        await signedRequest(JSON.stringify(payload)),
        env,
        { waitUntil: (promise) => { pending = promise; } },
      );
      expect(result).toEqual({ deliveryId: "delivery-1", duplicate: false, ignored: false });
      expect(deliverGitHubEvent).not.toHaveBeenCalled();
      await pending;
      expect(deliverGitHubEvent).toHaveBeenCalledOnce();
      expect(sqlite.prepare(
        "SELECT status,attempt_count FROM webhook_deliveries WHERE delivery_id='delivery-1'",
      ).get()).toEqual({ status: "delivered", attempt_count: 1 });
    } finally { sqlite.close(); }
  });

  it("persists a failed RPC and explicitly retries the same event", async () => {
    const { sqlite, db } = testDatabase();
    try {
      await seedInstallation(db);
      const deliverGitHubEvent = vi.fn()
        .mockRejectedValueOnce(new Error("Gardener unavailable"))
        .mockResolvedValueOnce({ accepted: true, duplicate: true, runIds: ["run-1"] });
      const env = environment(db, deliverGitHubEvent);
      let pending: Promise<unknown> | undefined;
      await acceptGitHubWebhook(
        await signedRequest(JSON.stringify(payload)),
        env,
        { waitUntil: (promise) => { pending = promise; } },
      );
      await pending;
      expect(sqlite.prepare(
        "SELECT status,attempt_count FROM webhook_deliveries WHERE delivery_id='delivery-1'",
      ).get()).toEqual({ status: "failed", attempt_count: 1 });

      await acceptGitHubWebhook(
        await signedRequest(JSON.stringify(payload)),
        env,
        { waitUntil: (promise) => { pending = promise; } },
      );
      await pending;
      expect(deliverGitHubEvent).toHaveBeenCalledOnce();
      expect(sqlite.prepare(
        "SELECT status,attempt_count FROM webhook_deliveries WHERE delivery_id='delivery-1'",
      ).get()).toEqual({ status: "failed", attempt_count: 1 });

      await expect(retryWebhookDelivery(env, "delivery-1")).resolves.toMatchObject({
        delivery: {
        status: "delivered",
          attempts: 2,
        },
      });
    } finally { sqlite.close(); }
  });

  it("synchronizes installation repository changes through the durable retry path", async () => {
    const { sqlite, db } = testDatabase();
    try {
      await seedInstallation(db);
      github.discoverRepositories.mockResolvedValue([{
        provider: "github",
        id: "9",
        installationId: "7",
        owner: "acme",
        name: "widgets",
        defaultBranch: "main",
      }]);
      const env = environment(db, vi.fn());
      let pending: Promise<unknown> | undefined;
      const changed = {
        action: "added",
        installation: { id: 7 },
        repositories_added: [{ id: 9, name: "widgets", full_name: "acme/widgets" }],
        repositories_removed: [],
      };
      await acceptGitHubWebhook(
        await signedRequest(
          JSON.stringify(changed),
          "delivery-repositories",
          "installation_repositories",
        ),
        env,
        { waitUntil: (promise) => { pending = promise; } },
      );
      await pending;
      expect(sqlite.prepare(
        "SELECT status,attempt_count FROM webhook_deliveries " +
        "WHERE delivery_id='delivery-repositories'",
      ).get()).toEqual({ status: "delivered", attempt_count: 1 });
      expect(sqlite.prepare("SELECT owner,name,active FROM repositories WHERE id='9'").get())
        .toEqual({ owner: "acme", name: "widgets", active: 1 });
    } finally { sqlite.close(); }
  });

  it("durably hash-binds verified events that are intentionally ignored", async () => {
    const { sqlite, db } = testDatabase();
    try {
      await seedInstallation(db);
      const env = environment(db, vi.fn());
      const ignoredPayload = {
        action: "added",
        installation: { id: 7 },
        repositories_added: [],
        repositories_removed: [],
      };
      await expect(acceptGitHubWebhook(
        await signedRequest(JSON.stringify(ignoredPayload), "delivery-ignored"),
        env,
        { waitUntil: () => undefined },
      )).resolves.toEqual({
        deliveryId: "delivery-ignored",
        duplicate: false,
        ignored: true,
      });
      expect(sqlite.prepare(
        "SELECT status,normalized_event_json,payload_hash FROM webhook_deliveries " +
        "WHERE delivery_id='delivery-ignored'",
      ).get()).toEqual({
        status: "delivered",
        normalized_event_json: null,
        payload_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    } finally { sqlite.close(); }
  });

  it("rejects reuse of a delivery id with different signed bytes", async () => {
    const { sqlite, db } = testDatabase();
    try {
      await seedInstallation(db);
      const env = environment(db, vi.fn().mockResolvedValue({
        accepted: true,
        duplicate: false,
        runIds: [],
      }));
      await acceptGitHubWebhook(
        await signedRequest(JSON.stringify(payload)),
        env,
        { waitUntil: () => undefined },
      );
      await expect(acceptGitHubWebhook(
        await signedRequest(JSON.stringify({ ...payload, action: "edited" })),
        env,
        { waitUntil: () => undefined },
      )).rejects.toMatchObject({ code: "delivery_id_payload_mismatch" });
    } finally { sqlite.close(); }
  });
});
