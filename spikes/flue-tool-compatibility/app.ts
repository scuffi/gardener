import { AgentRunError, init } from "@flue/runtime";
import { Hono } from "hono";
import { CanonicalToolProbe } from "./agent";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, service: "gardener-flue-tool-probe" }));

app.post("/runs", async (c) => {
  const body = await c.req.json<{ id?: unknown; model?: unknown; pauseMs?: unknown; mode?: unknown }>();
  if (typeof body.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(body.id)) {
    return c.json({ error: "invalid_id" }, 400);
  }
  if (typeof body.model !== "string" || !body.model.startsWith("@cf/")) {
    return c.json({ error: "invalid_model" }, 400);
  }
  if (body.pauseMs !== undefined && (typeof body.pauseMs !== "number" || body.pauseMs < 0 || body.pauseMs > 30_000)) {
    return c.json({ error: "invalid_pause" }, 400);
  }
  if (body.mode !== undefined && body.mode !== "exact" && body.mode !== "broad") {
    return c.json({ error: "invalid_mode" }, 400);
  }
  const receipt = await init(CanonicalToolProbe, { id: body.id }).dispatch({
    message: {
      kind: "signal",
      type: "probe.start",
      body: "Run list, read, and terminal tools in sequence.",
      attributes: { probeId: body.id },
    },
    initialData: {
      model: body.model,
      ...(typeof body.pauseMs === "number" ? { pauseMs: body.pauseMs } : {}),
      ...(body.mode === "exact" || body.mode === "broad" ? { mode: body.mode } : {}),
    },
    idempotencyKey: `probe:${body.id}`,
  });
  return c.json(receipt, 202);
});

app.get("/runs/:id/:submissionId", async (c) => {
  try {
    const reply = await init(CanonicalToolProbe, { id: c.req.param("id") }).read(c.req.param("submissionId"));
    return c.json({ ok: true, reply });
  } catch (error) {
    const cause = error instanceof AgentRunError ? error.cause : error;
    return c.json({
      ok: false,
      outcome: error instanceof AgentRunError ? error.outcome : "unknown",
      error: errorDetail(cause),
    }, 500);
  }
});

function errorDetail(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.cause === undefined ? {} : { cause: errorDetail(value.cause) }),
    };
  }
  if (value && typeof value === "object") {
    try { return JSON.parse(JSON.stringify(value)); }
    catch { return { type: Object.prototype.toString.call(value) }; }
  }
  return String(value);
}

export default app;
