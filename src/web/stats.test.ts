import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionSummary } from "../core/session.js";
import { computeSessionStats } from "./stats.js";

function summary(overrides: Partial<AgentSessionSummary>): AgentSessionSummary {
  return {
    id: "s1",
    title: "测试会话",
    status: "done",
    permissionMode: "normal",
    createdAt: "2026-08-09T02:00:00.000Z",
    updatedAt: "2026-08-09T03:00:00.000Z",
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    totalCachedTokens: 0,
    totalCostCny: 0.5,
    totalMissedTokens: 0,
    totalMissedCostCny: 0,
    todos: [],
    toolCallCount: 3,
    kind: "run",
    ...overrides,
  };
}

// 与 stats.ts 相同的本地时区归日逻辑（避免断言依赖机器时区）
function localDay(iso: string): string {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

test("computeSessionStats：总量计数 + 状态分桶 + 按天聚合", () => {
  // c 的 createdAt 与其余三个相差 25h，保证任何时区下归入不同的本地日
  const stats = computeSessionStats([
    summary({
      id: "a",
      createdAt: "2026-08-09T02:00:00.000Z",
      totalInputTokens: 1000,
      totalCostCny: 0.1,
    }),
    summary({
      id: "b",
      status: "error",
      createdAt: "2026-08-09T14:00:00.000Z",
      totalInputTokens: 2000,
      totalCostCny: 0.2,
    }),
    summary({
      id: "c",
      status: "interrupted",
      kind: "interactive",
      createdAt: "2026-08-08T01:00:00.000Z",
      totalInputTokens: 500,
      totalCostCny: 0.05,
    }),
    summary({
      id: "d",
      status: "running",
      createdAt: "2026-08-09T20:00:00.000Z",
      totalInputTokens: 300,
      totalCostCny: 0.03,
    }),
  ]);

  assert.deepEqual(stats.totals, {
    sessions: 4,
    running: 1,
    completed: 1,
    failed: 1,
    interrupted: 1,
    tokens: 3800,
    costCny: 0.38,
    runSessions: 3,
  });

  // 按天分桶：c 与其余会话相差 25h，任何时区下都在 c 自己的（最早的）桶里；
  // 其余会话的本地日可能跨日（取决于机器时区），只断言不变式
  const dayC = localDay("2026-08-08T01:00:00.000Z");
  const [first, ...rest] = stats.byDay;
  assert.ok(stats.byDay.length >= 2);
  assert.deepEqual(first, {
    day: dayC,
    sessions: 1,
    completed: 0,
    failed: 0,
    tokens: 500,
    costCny: 0.05,
  });
  const restSessions = rest.reduce((sum, bucket) => sum + bucket.sessions, 0);
  const restTokens = rest.reduce((sum, bucket) => sum + bucket.tokens, 0);
  const restCost = rest.reduce((sum, bucket) => sum + bucket.costCny, 0);
  assert.equal(restSessions, 3);
  assert.equal(restTokens, 3300);
  // 浮点累加（0.1 + 0.2 + 0.03）带尾差，按分位取整比较
  assert.ok(Math.abs(restCost - 0.33) < 1e-9);
  // 分桶严格按日升序
  const days = stats.byDay.map((bucket) => bucket.day);
  assert.deepEqual(days, [...days].sort());

  // 会话明细按创建时间倒序
  assert.deepEqual(
    stats.sessions.map((session) => session.id),
    ["d", "b", "a", "c"],
  );
});

test("computeSessionStats：空列表返回零值", () => {
  const stats = computeSessionStats([]);
  assert.deepEqual(stats.totals, {
    sessions: 0,
    running: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
    tokens: 0,
    costCny: 0,
    runSessions: 0,
  });
  assert.deepEqual(stats.byDay, []);
  assert.deepEqual(stats.sessions, []);
});
