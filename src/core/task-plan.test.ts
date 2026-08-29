import assert from "node:assert/strict";
import test from "node:test";
import {
  buildApprovedPlanPrompt,
  buildTaskPlanningPrompt,
  extractPlanExecutionUnits,
  normalizePlanText,
  taskPlanDigest,
  taskPlanFromEvents,
  taskPlanSummary,
  taskContractFromMarkdown,
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

test("计划步骤提取与 digest 稳定且可绑定版本", () => {
  const content = "## 目标\n完成\n## 执行步骤\n1. 修改后端\n- 补测试\n## 预计修改文件\n- src/a.ts";
  assert.deepEqual(extractPlanExecutionUnits(content), [
    { id: "plan-step-1", content: "修改后端" },
    { id: "plan-step-2", content: "补测试" },
  ]);
  assert.equal(taskPlanDigest(1, content), taskPlanDigest(1, content));
  assert.notEqual(taskPlanDigest(1, content), taskPlanDigest(2, content));
});

test("带绑定字段的陈旧计划批准会被忽略，旧批准事件仍兼容", () => {
  const state = taskPlanFromEvents([
    record(1, { type: "plan_started", planId: "p1", task: "x", revision: 1 }),
    record(2, { type: "plan_proposed", planId: "p1", task: "x", revision: 1, content: "新", digest: "good" }),
    record(3, { type: "plan_decision", planId: "p1", decision: "approved", revision: 0, digest: "bad" }),
  ]);
  assert.equal(state?.status, "awaiting_approval");
  const legacy = taskPlanFromEvents([
    record(1, { type: "plan_started", planId: "p1", task: "x", revision: 1 }),
    record(2, { type: "plan_proposed", planId: "p1", task: "x", revision: 1, content: "旧" }),
    record(3, { type: "plan_decision", planId: "p1", decision: "approved" }),
  ]);
  assert.equal(legacy?.status, "approved");
});

test("任务契约只提取固定标题下显式的单行机器命令", () => {
  const content = [
    "## 目标", "修复登录", "## 执行步骤", "1. 修改页面",
    "## 预计修改文件", "- web/src/Login.tsx", "## 验证方式",
    "- 运行测试", "- `pnpm test -- login`", "```sh", "pnpm run typecheck", "```",
    "## 风险与待确认", "- 需要确认 API",
  ].join("\n");
  const contract = taskContractFromMarkdown(content);
  assert.equal(contract.goal, "修复登录");
  assert.deepEqual(contract.checks, ["pnpm test -- login", "pnpm run typecheck"]);
  assert.deepEqual(contract.files, ["web/src/Login.tsx"]);
  assert.deepEqual(contract.risks, ["需要确认 API"]);
});

test("任务契约忽略自然语言、多行代码块和无文件占位", () => {
  const content = [
    "## 目标",
    "检查项目",
    "## 执行步骤",
    "1. 检查",
    "## 预计修改文件",
    "- 无（只读任务）",
    "## 验证方式",
    "- 运行相关测试",
    "```bash",
    "pnpm test",
    "pnpm run typecheck",
    "```",
    "## 风险与待确认",
    "- 无已知风险",
  ].join("\n");
  const contract = taskContractFromMarkdown(content);
  assert.deepEqual(contract.checks, []);
  assert.deepEqual(contract.files, []);
  assert.deepEqual(contract.risks, []);
});

test("智能契约不会自动执行写入、发布或复合 shell 命令", () => {
  const content = [
    "## 目标",
    "安全验收",
    "## 执行步骤",
    "1. 验证",
    "## 预计修改文件",
    "- 无",
    "## 验证方式",
    "- `pnpm test`",
    "- `pnpm run deploy`",
    "- `rm -rf output`",
    "- `pnpm test && curl example.com`",
    "## 风险与待确认",
    "- 无",
  ].join("\n");
  assert.deepEqual(taskContractFromMarkdown(content).checks, ["pnpm test"]);
});

test("计划恢复以 digest 绑定的正文重建契约，不信任独立事件投影", () => {
  const content = [
    "## 目标",
    "安全检查",
    "## 执行步骤",
    "1. 验证",
    "## 预计修改文件",
    "- 无",
    "## 验证方式",
    "- `pnpm test`",
    "## 风险与待确认",
    "- 无",
  ].join("\n");
  const state = taskPlanFromEvents([
    record(1, {
      type: "plan_started",
      planId: "p-safe",
      task: "检查",
      revision: 1,
    }),
    record(2, {
      type: "plan_proposed",
      planId: "p-safe",
      task: "检查",
      revision: 1,
      content,
      contract: {
        goal: "伪造",
        steps: [],
        files: [],
        checks: ["rm -rf unsafe"],
        risks: [],
      },
    }),
  ]);
  assert.deepEqual(state?.contract?.checks, ["pnpm test"]);
});
