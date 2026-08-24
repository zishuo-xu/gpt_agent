# Deterministic Harness Eval

`pnpm eval` is a provider-free regression suite for MyAgent's harness behavior.
It drives the real `AgentSession`, `AgentLoop`, permission engine, tool executor,
event store, and context layer with a deterministic scripted model client. It
does not call a network API and does not claim to measure real-model quality.

## Run

```bash
pnpm eval
pnpm eval -- --output /tmp/myagent-eval
```

The command exits non-zero when any scenario fails. By default it writes:

- `tmp/eval/report.json` for CI and trend tooling;
- `tmp/eval/report.md` for human review.

## Scenarios and pass conditions

| Scenario | Harness behavior | Pass condition |
| --- | --- | --- |
| `read` | Read tool round-trip | one successful Read and terminal `done` |
| `edit` | Read-before-edit and atomic edit | fixture contains the expected edit |
| `recovery` | tool error returned to the model | missing-file error followed by a successful tool call |
| `deny` | hard permission rule | denied `.env` is not created |
| `approval` | fail-closed approval timeout | approval requested, timed out, and file not created |
| `cost` | token and pricing projection | positive token and cost events |
| `budget` | unattended budget box | `run_finished(reason=budget)` is emitted |
| `replay` | event replay constructor path | replayed event count matches the source session |
| `branch` | conversation branching | a second branch is created at the selected event |
| `acceptance` | machine acceptance command | a passing `acceptance_result` precedes completed `run_finished` |
| `flight` | Flight Recorder run comparison | model and overlay changes are reported and the first `tool + target` divergence is index 0 |

`replay` intentionally covers the event-replay constructor path, not the full
on-disk `AgentSessionManager.restore()` path. Disk corruption and crash recovery
remain covered by the repository's unit/integration tests.

## Metrics

Every scenario reports:

- pass/fail and verification evidence;
- tool calls and tool errors;
- input/output/cached tokens and deterministic cost;
- duration in milliseconds;
- approval requests and denied/violating calls;
- recovery/replay status where applicable;
- emitted event types.

The scripted token counts and prices are fixtures. Use them to detect accounting
regressions, not as production cost or latency numbers. A future real-model eval
must record provider, model, date, task fixture revision, and actual usage/cost.
