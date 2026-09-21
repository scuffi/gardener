# Flue / Workers AI canonical tool compatibility

Date: 2026-09-21

## Required gate

A candidate must complete, without provider `tool_choice` forcing or host-authored tool results:

```text
model
  → repository_list_files
  → canonical tool result
  → repository_read_file
  → canonical tool result
  → submit_probe_result
  → Flue durable terminal reply
```

The terminal tool validates an exact sentinel returned only by `repository_read_file`.

## Isolation

The probe used the disposable `gardener-flue-tool-probe-baseline` Worker and its own generated Flue
Durable Object class. It had no Gardener enrollment, GitHub token, repository credentials, D1 product
state, or persistent effects. The working Gardener demo runtime was not modified.

## Matrix

| Candidate | Llama 3.3 70B | GPT-OSS 20B | GPT-OSS 120B | Kimi K2.6 |
|---|---|---|---|---|
| Flue 2.0.3 / pi-ai 0.83.0 | Model stopped without terminal tool | Workers AI `400` transcript rejection | Workers AI `400` transcript rejection | Pass |
| Flue 2.0.8 / pi-ai 0.85.1 | Model stopped without terminal tool | Workers AI `400` transcript rejection | Workers AI `400` transcript rejection | Pass |
| Flue 2.1.0 / pi-ai 0.86.1 | Model stopped without terminal tool | Workers AI `400` transcript rejection | Workers AI `400` transcript rejection | Pass |

The GPT-OSS failures occurred after Flue had durable response/tool activity. Workers AI rejected the
continued transcript with error `5006` / HTTP `400`:

```text
oneOf at '/' not met
messages/0/content: array is not string
messages/1/content: string is not array
messages/2/content: string is not null
```

Kimi K2.6 completed the exact ordered sequence on every dependency row without Gardener's
bounded-provider payload rewrite, fixed repository preflight, forced tool selection, or direct D1
terminal persistence.

## Reliability and durability

Flue 2.1.0 / pi-ai 0.86.1 with `@cf/moonshotai/kimi-k2.6` completed 10/10 sequential runs. Every run
reported exactly:

```json
[
  "repository_list_files",
  "repository_read_file",
  "submit_probe_result"
]
```

A separate run paused inside the durable `repository_list_files` tool while the Worker was redeployed.
The submission resumed and completed the same exact list/read/terminal sequence after deployment.

The same Kimi sequence also passed on the current Gardener pins (Flue 2.0.3 / pi-ai 0.83.0) and on
the intermediate candidate (Flue 2.0.8 / pi-ai 0.85.1). Dependency upgrades are therefore not
required to unblock canonical tools; the model/provider wire compatibility is the determining factor.

## Result

`@cf/moonshotai/kimi-k2.6` is the only tested model that passed the canonical tool gate. Gardener
retained Flue 2.0.3/pi-ai 0.83.0 to minimize release risk. Product promotion subsequently removed the
fixed preflight, forced tool selection, custom Workers AI provider, and direct D1 terminal persistence.
The public demo's bug-intake and documentation tasks both completed canonical list/read/finish flows
on attempt 1; private-repository requalification remains a separate release gate.
