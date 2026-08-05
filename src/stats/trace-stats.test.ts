import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateTraces,
  type AgentTurnTraceLike,
} from "./trace-stats.js";

function turn(
  overrides: Partial<AgentTurnTraceLike> & { tools: AgentTurnTraceLike["tools"] },
): AgentTurnTraceLike {
  return { turn: 1, ts: "2026-08-05T00:00:00.000Z", ...overrides };
}

test("aggregateTraces 统计 diff 占比与 bash 截断", () => {
  const editDiff = "diff-1x\n".repeat(400); // 8 字符 × 400 = 3200 字符
  const multiDiff = "diff-2x\n".repeat(200); // 8 字符 × 200 = 1600 字符
  const traces: AgentTurnTraceLike[] = [
    turn({
      usage: { input: 10_000, output: 500, cached: 6_000 },
      tools: [
        {
          call: { id: "1", tool: "Edit", target: "src/a.ts", args: {} },
          permission: "allow",
          result: {
            summary: "已编辑",
            output: editDiff,
          },
          ms: 5,
        },
        {
          call: { id: "2", tool: "MultiEdit", target: "src/b.ts", args: {} },
          permission: "allow",
          result: {
            summary: "已完成",
            output: multiDiff,
          },
          ms: 6,
        },
        {
          call: { id: "3", tool: "Bash", target: "pnpm test", args: {} },
          permission: "allow",
          result: {
            summary: "命令退出：1",
            details: { truncated: true, outputIncomplete: false },
          },
          ms: 7,
        },
      ],
    }),
    turn({
      usage: { input: 8_000, output: 300, cached: 0 },
      tools: [
        {
          call: { id: "4", tool: "Read", target: "src/c.ts", args: {} },
          permission: "allow",
          result: { summary: "已读取", output: "content", details: {} },
          ms: 3,
        },
      ],
    }),
  ];

  const stats = aggregateTraces(traces);
  assert.equal(stats.turns, 2);
  assert.equal(stats.inputTokens, 18_000);
  assert.equal(stats.outputTokens, 800);
  assert.equal(stats.cachedTokens, 6_000);
  assert.equal(stats.cacheRate, 6000 / 18000);
  // Edit + MultiEdit diff 共 3200 + 1600 = 4800 字符
  assert.equal(stats.editCalls, 2);
  assert.equal(stats.diffTotalChars, 4_800);
  // diff 字符占 input 字符当量（tokens × 4）的比例
  assert.ok(stats.diffCharsPerInputChar !== null);
  assert.ok(
    Math.abs(stats.diffCharsPerInputChar! - 4800 / (18_000 * 4)) < 1e-9,
  );
  // Bash 只有 1 次调用，截断 1 次
  assert.equal(stats.bashCalls, 1);
  assert.equal(stats.bashTruncated, 1);
  assert.equal(stats.bashOutputIncomplete, 0);
});

test("aggregateTraces 容错：result 缺失 / 无 usage / 空 trace", () => {
  const traces: AgentTurnTraceLike[] = [
    turn({
      tools: [
        {
          call: { id: "1", tool: "Edit", target: "a", args: {} },
          permission: "deny",
          ms: 1,
        },
      ],
    }),
  ];
  const stats = aggregateTraces(traces);
  assert.equal(stats.turns, 1);
  assert.equal(stats.editCalls, 0, "被拒绝的工具不产生 diff");
  assert.equal(stats.inputTokens, 0);
  assert.equal(stats.cacheRate, null);

  const empty = aggregateTraces([]);
  assert.equal(empty.turns, 0);
  assert.equal(empty.diffTotalChars, 0);
});

test("aggregateTraces 只统计 diff 文本型 output，非字符串忽略", () => {
  const traces: AgentTurnTraceLike[] = [
    turn({
      tools: [
        {
          call: { id: "1", tool: "Edit", target: "a", args: {} },
          permission: "allow",
          result: { summary: "已编辑", output: 42 },
          ms: 1,
        },
      ],
    }),
  ];
  assert.equal(aggregateTraces(traces).diffTotalChars, 0);
});
