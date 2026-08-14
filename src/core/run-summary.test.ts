import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "./types.js";
import { extractRunSummary } from "./run-summary.js";

const T0 = "2026-08-09T10:00:00.000Z";
const T1 = "2026-08-09T10:35:00.000Z";

function record(ts: string, event: AgentEvent) {
  return { seq: 0, ts, sessionId: "s1", branchId: "main", event };
}

function runStarted(taskId = "task-1"): AgentEvent {
  return {
    type: "run_started",
    taskId,
    description: "巡检仓库",
    permissionMode: "normal",
    hardRules: [],
  };
}

function runFinished(
  status: "completed" | "interrupted" | "failed" = "completed",
  taskId = "task-1",
): AgentEvent {
  return {
    type: "run_finished",
    taskId,
    status,
    ...(status === "completed" ? { reason: "done" } : {}),
  };
}

function textChunks(chunks: string[]): AgentEvent[] {
  return chunks.map((text) => ({ type: "text_delta", text }));
}

test("提取收尾总结：最后一段助手文本 + todo 快照 + 时间范围", () => {
  const events: AgentEvent[] = [
    runStarted(),
    { type: "todo_update", todos: [{ id: "a", content: "检查", status: "pending" }] },
    ...textChunks(["中间过程文本", "，不是总结"]),
    { type: "tool_call", call: { id: "c1", tool: "Bash", target: "ls", args: {} } },
    { type: "tool_result", callId: "c1", summary: "ok" },
    { type: "todo_update", todos: [{ id: "a", content: "检查", status: "completed" }] },
    ...textChunks(["收尾总结：", "全部检查通过，", "改动见上。"]),
    runFinished(),
  ];
  const run = extractRunSummary(events.map((event, index) => record(index === 0 ? T0 : T1, event)));
  assert.ok(run);
  assert.equal(run.taskId, "task-1");
  assert.equal(run.description, "巡检仓库");
  assert.equal(run.status, "completed");
  assert.equal(run.reason, "done");
  assert.equal(run.summary, "收尾总结：全部检查通过，改动见上。");
  assert.deepEqual(run.todos, [{ id: "a", content: "检查", status: "completed" }]);
  assert.equal(run.startedAt, T0);
  assert.equal(run.finishedAt, T1);
  assert.equal(run.durationMs, 35 * 60_000);
});

test("text_delta 跨段合并：只取收尾最后一段助手文本", () => {
  const events: AgentEvent[] = [
    runStarted(),
    ...textChunks(["第一段回答", "（继续）"]),
    { type: "tool_call", call: { id: "c1", tool: "Bash", target: "ls", args: {} } },
    { type: "tool_result", callId: "c1", summary: "ok" },
    ...textChunks(["最终收尾段落", "（总结完毕）"]),
    runFinished(),
  ];
  const run = extractRunSummary(events.map((event) => record(T1, event)));
  assert.equal(run?.summary, "最终收尾段落（总结完毕）");
});

test("failed 状态与无总结（只有 run_finished 无助手文本）", () => {
  const events: AgentEvent[] = [
    runStarted(),
    { type: "error", message: "模型调用失败" },
    runFinished("failed"),
  ];
  const run = extractRunSummary(events.map((event) => record(T1, event)));
  assert.ok(run);
  assert.equal(run.status, "failed");
  assert.equal(run.reason, undefined);
  assert.equal(run.summary, "");
  assert.deepEqual(run.todos, []);
});

test("无 run_finished 或没有 run_started 时返回 undefined", () => {
  const startedOnly = extractRunSummary([record(T0, runStarted())]);
  assert.equal(startedOnly, undefined);
  const finishedOnly = extractRunSummary([record(T1, runFinished())]);
  assert.equal(finishedOnly, undefined);
  const plain = extractRunSummary([
    record(T0, { type: "user", text: "你好" }),
  ]);
  assert.equal(plain, undefined);
});

test("多轮任务：取最后一次配对的总结", () => {
  const events: AgentEvent[] = [
    runStarted(),
    ...textChunks(["第一轮总结"]),
    runFinished(),
    // 第二轮（续跑）
    runStarted("task-2"),
    ...textChunks(["第二轮总结"]),
    runFinished("interrupted", "task-2"),
  ];
  const run = extractRunSummary(events.map((event) => record(T1, event)));
  assert.ok(run);
  assert.equal(run.taskId, "task-2");
  assert.equal(run.status, "interrupted");
  assert.equal(run.summary, "第二轮总结");
});
