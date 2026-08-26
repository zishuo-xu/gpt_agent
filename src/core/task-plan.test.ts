import assert from "node:assert/strict";
import test from "node:test";
import {
  buildApprovedPlanPrompt,
  buildTaskPlanningPrompt,
  normalizePlanText,
  taskPlanFromEvents,
  taskPlanSummary,
} from "./task-plan.js";
import type { AgentEvent, RecordedEvent } from "./types.js";

function record(seq: number, event: AgentEvent): RecordedEvent {
  return {
    seq,
    ts: new Date(seq * 1000).toISOString(),
    sessionId: "s1",
    event,
  };
}

test("taskPlanFromEvents：提出、修改、重新提出与批准均可恢复", () => {
  const state = taskPlanFromEvents([
    record(1, {
      type: "plan_started",
      planId: "p1",
      task: "实现功能",
      revision: 1,
    }),
    record(2, {
      type: "plan_proposed",
      planId: "p1",
      task: "实现功能",
      revision: 1,
      content: "第一版",
    }),
    record(3, {
      type: "plan_decision",
      planId: "p1",
      decision: "revision_requested",
      feedback: "不要改 API",
    }),
    record(4, {
      type: "plan_started",
      planId: "p1",
      task: "实现功能",
      revision: 2,
    }),
    record(5, {
      type: "plan_proposed",
      planId: "p1",
      task: "实现功能",
      revision: 2,
      content: "第二版",
    }),
    record(6, {
      type: "plan_decision",
      planId: "p1",
      decision: "approved",
    }),
  ]);
  assert.deepEqual(state, {
    planId: "p1",
    task: "实现功能",
    revision: 2,
    status: "approved",
    content: "第二版",
  });
  assert.deepEqual(taskPlanSummary(state), {
    planId: "p1",
    task: "实现功能",
    revision: 2,
    status: "approved",
  });
});

test("taskPlanFromEvents：旧会话为空，迟到决定不污染新计划", () => {
  assert.equal(taskPlanFromEvents([]), undefined);
  const state = taskPlanFromEvents([
    record(1, {
      type: "plan_started",
      planId: "old",
      task: "旧任务",
      revision: 1,
    }),
    record(2, {
      type: "plan_started",
      planId: "new",
      task: "新任务",
      revision: 1,
    }),
    record(3, {
      type: "plan_decision",
      planId: "old",
      decision: "approved",
    }),
  ]);
  assert.deepEqual(state, {
    planId: "new",
    task: "新任务",
    revision: 1,
    status: "planning",
  });
});

test("taskPlanFromEvents：规划失败保留错误证据", () => {
  const state = taskPlanFromEvents([
    record(1, {
      type: "plan_started",
      planId: "p1",
      task: "分析",
      revision: 1,
    }),
    record(2, {
      type: "plan_failed",
      planId: "p1",
      revision: 1,
      message: "模型不可用",
    }),
  ]);
  assert.equal(state?.status, "failed");
  assert.equal(state?.error, "模型不可用");
});

test("规划提示与批准提示明确阶段边界，流式前言可规范化", () => {
  const planning = buildTaskPlanningPrompt({
    task: "实现登录",
    previousPlan: "旧计划",
    feedback: "不要改数据库",
  });
  assert.match(planning, /只可使用 Read、Grep、Glob/);
  assert.match(planning, /不要改数据库/);
  assert.match(planning, /## 风险与待确认/);

  const plan = "## 目标\n完成\n## 执行步骤\n1. 做";
  assert.equal(normalizePlanText(`先看一下\n${plan}`), plan);
  assert.match(buildApprovedPlanPrompt("实现登录", plan), /用户已经批准/);
});
