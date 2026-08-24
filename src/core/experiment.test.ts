import assert from "node:assert/strict";
import test from "node:test";
import { conversationFromAt } from "./branch.js";
import { computeExperimentDiff } from "./experiment-diff.js";
import type { ExperimentSessionMeta } from "./experiment.js";
import type { AgentTurnTrace } from "./events.js";
import type { BranchEventLike } from "./branch.js";

const meta = (overrides: Partial<ExperimentSessionMeta> = {}): ExperimentSessionMeta => ({
  version: 1,
  parentSessionId: "parent",
  parentTurnId: "turn-1",
  parentEventSeq: 5,
  projectCwd: "/tmp/project",
  workspaceSnapshot: {
    worktreePath: "/tmp/worktree",
    cwd: "/tmp/worktree",
    gitRoot: "/tmp/project",
    head: "abc123",
    untrackedCopied: [],
    warnings: [],
  },
  pinnedModel: { providerId: "p", model: "m" },
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const ev = (seq: number, event: BranchEventLike["event"], branchId?: string): BranchEventLike => ({
  seq,
  ts: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
  event,
  ...(branchId ? { branchId } : {}),
});

test("conversationFromAt uses branch state at cutoff, excluding future switches", () => {
  const records = [
    ev(1, { type: "user", text: "start" }),
    ev(2, { type: "branch_switch", branchId: "b1", parent: "main", forkSeq: 1 }, "b1"),
    ev(3, { type: "user", text: "branch one" }, "b1"),
    ev(4, { type: "branch_switch", branchId: "b2", parent: "main", forkSeq: 1 }, "b2"),
    ev(5, { type: "user", text: "future branch" }, "b2"),
  ];
  assert.deepEqual(conversationFromAt(records, 3).map((m) => m.content), ["start", "branch one"]);
});

test("conversationFromAt preserves compaction and closes orphan tool calls", () => {
  const records = [
    ev(1, { type: "user", text: "old" }),
    ev(2, { type: "context_compacted", summary: "old summary", ratio: 1, keepFromSeq: 3 }),
    ev(3, { type: "tool_call", call: { id: "c", tool: "Read", target: "a", args: {} } }),
  ];
  const messages = conversationFromAt(records, 3);
  assert.equal(messages[0]?.content, "[会话压缩摘要]\nold summary");
  assert.equal(messages[2]?.role, "tool");
});

test("computeExperimentDiff compares tools, usage, status and first divergence", () => {
  const trace = (tool: string, target: string, input: number): AgentTurnTrace => ({
    version: 2,
    turn: 1,
    ts: "2026-01-01T00:00:00.000Z",
    turnId: tool,
    tools: [{ call: { id: tool, tool, target, args: {} }, permission: "allow", ms: 1 }],
    usage: { input, output: 2, cached: 1 },
  });
  const diff = computeExperimentDiff(
    { meta: meta(), traces: [trace("Read", "a", 10)], summary: { status: "failed", totalCostCny: 1 } },
    { meta: meta({ pinnedModel: { providerId: "q", model: "new" }, systemPromptOverlay: "be concise" }), traces: [trace("Read", "b", 20)], summary: { status: "completed", totalCostCny: 2 } },
  );
  assert.equal(diff.model.changed, true);
  assert.equal(diff.overlay.changed, true);
  assert.equal(diff.tools.firstDivergence?.index, 0);
  assert.deepEqual(diff.tokens.delta, { input: 10, output: 0, cached: 0 });
  assert.equal(diff.costCny.delta, 1);
  assert.equal(diff.status.changed, true);
});
