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
test("interactive status maps done/error/running without run events", () => {
  assert.equal(projectDelivery([r(1, { type: "done" })] as any, { title: "问答", status: "done" }).outcome, "completed");
  assert.equal(projectDelivery([r(1, { type: "error", message: "坏了" })] as any, { title: "问答", status: "error" }).outcome, "failed");
  assert.equal(projectDelivery([r(1, { type: "need_user", question: "继续吗" })] as any, { title: "问答", status: "waiting_plan" }).outcome, "running");
});
test("interrupted event takes precedence over an otherwise completed session", () => {
  const delivery = projectDelivery([
    r(1, { type: "run_started", taskId: "t", description: "任务" }),
    r(2, { type: "interrupted", scope: "tool" }),
    r(3, { type: "run_finished", taskId: "t", status: "completed" }),
  ] as any);
  assert.equal(delivery.outcome, "interrupted");
});
test("acceptance projection includes output, exit code and duration from latest attempt", () => {
  const delivery = projectDelivery([
    r(1, { type: "run_started", taskId: "t", description: "验收" }),
    r(2, { type: "acceptance_result", taskId: "t", attempt: 1, index: 0, command: "old", status: "failed", durationMs: 2, output: "old" }),
    r(3, { type: "acceptance_result", taskId: "t", attempt: 2, index: 0, command: "test", status: "passed", durationMs: 12, exitCode: 0, output: "ok" }),
  ] as any);
  assert.deepEqual(delivery.checks, [{ command: "test", status: "passed", exitCode: 0, durationMs: 12, output: "ok" }]);
});
test("review projection preserves issues", () => {
  const delivery = projectDelivery([
    r(1, { type: "review_result", passed: false, issues: ["缺少测试"], summary: "需要修复", attempts: 1 }),
  ] as any);
  assert.equal(delivery.review, "failed");
  assert.deepEqual(delivery.reviewResult?.issues, ["缺少测试"]);
});
test("failed or aborted write results are excluded from changed files", () => {
  const delivery = projectDelivery([
    r(1, { type: "tool_call", call: { id: "a", tool: "Write", target: "bad.ts" } }),
    r(2, { type: "tool_result", callId: "a", summary: "失败", isError: true }),
    r(3, { type: "tool_call", call: { id: "b", tool: "Edit", target: "aborted.ts" } }),
    r(4, { type: "tool_result", callId: "b", summary: "中断", aborted: true }),
  ] as any);
  assert.deepEqual(delivery.files, []);
});
