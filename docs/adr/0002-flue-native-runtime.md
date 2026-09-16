# ADR 0002: Flue-native Agent runtime

**Status:** Accepted for cutover implementation  
**Date:** 2026-09-16

## Decision

Gardener admits each live run directly to the static `GardenerFlueAgent` (`FlueGardenerHarnessAgent`) using the run ID and a deterministic immutable request ID as Flue's idempotency key. New runs use `runtime_driver=flue-native-v1` and `bounded-issue-comment-v4`; no per-run Cloudflare Workflow is created.

Flue owns its conversation, one qualified model turn, native tool call, durable tool steps, recovery, and abort. D1 remains authoritative for event/run identity, frozen policy and model selection, cancellation intent, canonical output, exact effect, Gateway receipt, product status, and audit. Gardener does not mirror Flue turns or tool steps into `run_tasks` or `run_steps`.

The trusted, versioned `submit_gardener_output_v1` terminal tool is mounted by host code. The model can supply only an abstention or bounded comment proposal. Host code derives the existing operation ID, canonical operation hash, effect ID, and marker and calls the user-deployed GitHub Gateway. Native provider mode preserves Flue tools, omits structured assistant `response_format`, and enforces final-payload, output-token, and frozen-deadline limits.

Thrown or retryable Gateway attempts are retried inside the same durable terminal tool over the exact frozen operation, with stable versioned per-attempt step names, fresh live-authority checks, a frozen deadline, and bounded backoff. Effect creation and execution claims are database-fenced on an active uncancelled run. Every abandonment path becomes non-active: known pre-provider failures are explicit, while any possibly applied Gateway call becomes a hash-bound `gateway_outcome_unknown` failure plus a deduplicated Inbox item. Durable-step rejection, Agent finish, and completed/abnormal/cancelled reconciliation all repair a nonterminal effect before run terminalization. Cron never executes effects. A typed nonretryable receipt may terminalize failure. The provider rejects any second model turn from the durable conversation context, malformed or failed terminal calls return a sanitized terminating result, and a D1 singleton fence permits only one terminal invocation to enter effect work. Missing terminal output fails at `useAgentFinish`; this profile never appends a continuation turn.

One minute D1/Cron reconciliation repairs dispatch and settlement gaps. Admission atomically inserts the run, exact immutable request JSON/hash, and outbox while freezing model/profile/request-protocol identifiers. A missing request or outbox is therefore an admission-integrity failure: Cron reports it and fails closed rather than regenerating request bytes or manufacturing outbox state. Once cancellation is persisted, live authority denies effects immediately. With no receipt, Cron never dispatches unless supported Flue instance lookup proves an existing instance; keyed replay may then only adopt that instance's receipt before abort.

## Consequences

- `gardener-flue-native/v1` is a product adapter tag, independent of `flue@2.0.3`.
- Historical `workflow-v1` and older adapter rows remain readable but are never resumed natively.
- The Flue Durable Object class identity and migration history remain unchanged.
- Effect and submission receipts each retain one canonical D1 ledger; the outbox carries only delivery/reconciliation state.
- Cutover requires pause/drain, schema 8, Cron verification, real-target keyed replay/effect qualification, and an explicit release decision while globally paused.
