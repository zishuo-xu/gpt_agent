import test from "node:test";
import assert from "node:assert/strict";
import { projectDelivery } from "./delivery.js";
const r = (seq: number, event: any) => ({ seq, ts: `2026-01-01T00:00:0${seq}.000Z`, event });
test("delivery 只统计成功文件调用并取最新验收 attempt", () => {
  const d = projectDelivery([
    r(1, { type: "run_started", taskId: "t", description: "改代码", hardRules: [], permissionMode: "normal" }),
    r(2, { type: "tool_call", call: { id: "a", tool: "Write", target: "a.ts" } }),
    r(3, { type: "tool_result", callId: "a", summary: "ok" }),
    r(4, { type: "tool_call", call: { id: "b", tool: "Edit", target: "b.ts" } }),
    r(5, { type: "tool_result", callId: "b", summary: "bad", isError: true }),
    r(6, { type: "acceptance_result", taskId: "t", attempt: 1, command: "old", index: 0, status: "failed", durationMs: 1 }),
    r(7, { type: "acceptance_result", taskId: "t", attempt: 2, command: "new", index: 0, status: "passed", durationMs: 2 }),
    r(8, { type: "run_finished", taskId: "t", status: "completed" }),
  ] as any);
  assert.deepEqual(d.files, ["a.ts"]); assert.deepEqual(d.checks.map((c) => c.command), ["new"]); assert.equal(d.verification, "passed");
});
test("delivery distinguishes failed, interrupted and not-run", () => {
  assert.equal(projectDelivery([r(1, { type: "run_started", taskId: "x", description: "x" }), r(2, { type: "run_finished", taskId: "x", status: "failed" })] as any).outcome, "failed");
  assert.equal(projectDelivery([r(1, { type: "run_started", taskId: "x", description: "x" }), r(2, { type: "run_finished", taskId: "x", status: "interrupted" })] as any).outcome, "interrupted");
  assert.equal(projectDelivery([r(1, { type: "user", text: "hello" })] as any).verification, "not_run");
});
