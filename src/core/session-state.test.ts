import assert from "node:assert/strict";
import test from "node:test";
import { SessionStateMachine } from "./session-state.js";
import type { SessionStateDeps } from "./session-state.js";
import type { AgentEvent } from "./types.js";

/**
 * SessionStateMachine 直接单测：事件 → 状态/成本/todo 的状态机语义。
 * deps 用桩（setMode/noteSwitch/setTodos 记录调用），不依赖真实组件。
 */

function stubDeps() {
  const calls: string[] = [];
  const deps: SessionStateDeps = {
    permissions: {
      setMode: (mode: string) => calls.push(`setMode:${mode}`),
    } as unknown as SessionStateDeps["permissions"],
    branchOps: {
      noteSwitch: (branchId: string) => calls.push(`noteSwitch:${branchId}`),
    } as unknown as SessionStateDeps["branchOps"],
    model: {
      setTodos: (todos: unknown) =>
        calls.push(`setTodos:${(todos as Array<{ id: string }>).length}`),
    } as unknown as SessionStateDeps["model"],
  };
  return { deps, calls };
}

function costEvent(partial: Record<string, unknown>): AgentEvent {
  return {
    type: "cost_update",
    input: 0,
    output: 0,
    cached: 0,
    ...partial,
  } as AgentEvent;
}

test("状态切换：user/ask/done/need_user/error/interrupted 驱动 status", () => {
  const machine = new SessionStateMachine();
  const { deps } = stubDeps();
  assert.equal(machine.status, "idle");
  machine.apply({ type: "user", text: "hi" }, deps);
  assert.equal(machine.status, "running");
  machine.apply({ type: "ask_permission", call: { id: "c", tool: "Bash", target: "ls", args: {} }, risk: "r", detail: "d" }, deps);
  assert.equal(machine.status, "waiting_permission");
  machine.apply({ type: "done" }, deps);
  assert.equal(machine.status, "done");
  machine.apply({ type: "user", text: "again" }, deps);
  machine.apply({ type: "need_user", question: "q" }, deps);
  assert.equal(machine.status, "waiting_user", "need_user 进入等待用户回答");
  machine.apply({ type: "error", message: "e" }, deps);
  assert.equal(machine.status, "error");
  machine.apply({ type: "interrupted", scope: "loop" }, deps);
  assert.equal(machine.status, "interrupted");
});

test("计划门状态：规划中 → 等待确认 → 修改/批准/仅分析/失败", () => {
  const machine = new SessionStateMachine();
  const { deps } = stubDeps();
  machine.apply(
    { type: "plan_started", planId: "p1", task: "修复问题", revision: 1 },
    deps,
  );
  assert.equal(machine.status, "running");
  machine.apply(
    {
      type: "plan_proposed",
      planId: "p1",
      task: "修复问题",
      revision: 1,
      content: "## 执行步骤",
    },
    deps,
  );
  assert.equal(machine.status, "waiting_plan");
  machine.apply(
    {
      type: "plan_decision",
      planId: "p1",
      decision: "revision_requested",
      feedback: "减少改动",
    },
    deps,
  );
  assert.equal(machine.status, "running");
  machine.apply(
    { type: "plan_decision", planId: "p1", decision: "approved" },
    deps,
  );
  assert.equal(machine.status, "running");
  machine.apply(
    { type: "plan_decision", planId: "p1", decision: "analysis_only" },
    deps,
  );
  assert.equal(machine.status, "done");
  machine.apply(
    { type: "plan_failed", planId: "p1", revision: 2, message: "失败" },
    deps,
  );
  assert.equal(machine.status, "error");
});

test("成本累计：token/费用/缓存浪费 + 维度桶（按 providerId/model 拆分，费用降序）", () => {
  const machine = new SessionStateMachine();
  const { deps } = stubDeps();
  machine.apply(
    costEvent({ input: 100, output: 50, cached: 30, providerId: "a", model: "m1" }),
    deps,
  );
  machine.apply(
    costEvent({ input: 10, output: 5, cached: 0, providerId: "b", model: "m2", costCny: 0.5 }),
    deps,
  );
  machine.apply(
    costEvent({
      input: 20,
      output: 10,
      cached: 5,
      providerId: "a",
      model: "m1",
      costCny: 0.2,
      missedTokens: 15,
      missedReason: "idle",
      missedCostCny: 0.1,
    }),
    deps,
  );
  assert.equal(machine.inputTokens(), 130);
  assert.equal(machine.outputTokens(), 65);
  assert.equal(machine.cachedTokens(), 35);
  assert.equal(machine.costCny(), 0.7);
  assert.equal(machine.missedTokens(), 15, "异常失效计入");
  assert.equal(machine.missedCostCny(), 0.1);
  const byModel = machine.costByModel();
  assert.equal(byModel.length, 2);
  assert.equal(byModel[0]!.providerId, "b", "费用降序排前");
  assert.equal(byModel[0]!.costCny, 0.5);
  assert.equal(byModel[1]!.tokens, 180, "a/m1 两轮 token 累计");
});

test("成本累计：压缩重置的缓存失效不计入浪费", () => {
  const machine = new SessionStateMachine();
  const { deps } = stubDeps();
  machine.apply(
    costEvent({ input: 1, output: 1, missedTokens: 999, missedReason: "compaction" }),
    deps,
  );
  assert.equal(machine.missedTokens(), 0, "压缩属合法重置，不计入浪费");
});

test("todo_update：快照替换 + 回灌模型 setTodos", () => {
  const machine = new SessionStateMachine();
  const { deps, calls } = stubDeps();
  machine.apply(
    { type: "todo_update", todos: [{ id: "a", content: "x", status: "in_progress" }] },
    deps,
  );
  assert.equal(machine.todos().length, 1);
  assert.deepEqual(machine.todos()[0], { id: "a", content: "x", status: "in_progress" });
  assert.ok(calls.includes("setTodos:1"), "模型上下文同步");
  // 快照隔离：summary 层 clone 后使用（todos() 返回内部引用，见 session.ts summary）
});

test("权限档与分支切换事件：委托到 permissions/branchOps", () => {
  const machine = new SessionStateMachine();
  const { deps, calls } = stubDeps();
  machine.apply({ type: "permission_mode_changed", mode: "trust" }, deps);
  assert.ok(calls.includes("setMode:trust"));
  machine.apply({ type: "branch_switch", branchId: "b2", parent: "main", forkSeq: 5 }, deps);
  assert.ok(calls.includes("noteSwitch:b2"));
});
