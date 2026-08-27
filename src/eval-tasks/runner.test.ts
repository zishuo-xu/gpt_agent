import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTaskReport } from "./report.js";
import { classifyCompletion, runDevTaskEval } from "./runner.js";
const execFileAsync = promisify(execFile);

test("报告按 direct/plan 汇总任务完成与可靠完成率", () => {
  const base = { scenario: "x", outcomePassed: true, declaredCompleted: true, reliableCompletion: true, falseCompletion: false, interventions: 0, acceptanceAttempts: 1, toolCalls: 2, errors: 0, tokens: { input: 1, output: 2, cached: 0, total: 3 }, cost: 0, durationMs: 1, planUnits: { total: 0, completed: 0, verified: 0, pending: 0, blocked: 0 }, verification: { command: "test", commandPassed: true, shapePassed: true, output: "ok" }, workspaceKept: false };
  const report = createTaskReport([{ ...base, mode: "direct" }, { ...base, mode: "plan", outcomePassed: false, reliableCompletion: false, falseCompletion: true }], "provider-free-harness");
  assert.equal(report.summary.taskCompletionRate, 0.5);
  assert.equal(report.summary.reliableCompletionRate, 0.5);
  assert.equal(report.summary.falseCompletionCount, 1);
  assert.equal(report.summary.byMode.plan.outcomePassed, 0);
  assert.equal(report.summary.byMode.direct.averageTokens, 3);
});

test("结果通过但计划账本未闭环时不算可靠完成", () => {
  const result = classifyCompletion({
    outcomePassed: true,
    runCompleted: true,
    mode: "plan",
    planUnits: { total: 3, completed: 0, verified: 2, pending: 1, blocked: 0 },
    expectedPlanUnits: 3,
  });
  assert.deepEqual(result, {
    declaredCompleted: true,
    reliableCompletion: false,
    falseCompletion: true,
  });
});

test("所有 fixture 初态都尚未满足各自的外部验收", async () => {
  const root = path.resolve("examples/dev-tasks");
  const math = await readFile(path.join(root, "bugfix-add/src/math.js"), "utf8");
  assert.match(math, /return a - b/);
  const greeting = await readFile(path.join(root, "cross-file-greeting/src/greeting.js"), "utf8");
  const index = await readFile(path.join(root, "cross-file-greeting/src/index.js"), "utf8");
  assert.match(greeting, /function greeting\(name\)/);
  assert.match(index, /return greeting\(name\)/);
  const refactor = await readFile(path.join(root, "refactor-normalize/src/strings.js"), "utf8");
  assert.equal((refactor.match(/replaceAll/g) ?? []).length, 2);
});

test("provider-free 三场景 direct/plan 通过外部 node --test 验收", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "myagent-task-report-"));
  try {
    const result = await runDevTaskEval({ mode: "both", outputDir, keep: false });
    assert.equal(result.report.runs.length, 6);
    assert.ok(result.report.runs.every((run) => run.outcomePassed), JSON.stringify(result.report.runs));
    assert.ok(result.report.runs.filter((run) => run.mode === "plan").every((run) => run.acceptanceAttempts >= 1 && run.planUnits.total === 3 && run.planUnits.verified >= 3));
    assert.ok(result.report.runs.filter((run) => run.mode === "direct").every((run) => run.planUnits.total === 0));
    assert.equal(result.report.summary.taskCompletionRate, 1);
    assert.equal(result.report.summary.reliableCompletionRate, 1);
    assert.ok(result.report.runs.every((run) => run.workspaceKept === false));
    assert.ok(result.report.runs.every((run) => run.verification.commandPassed && run.verification.shapePassed));
    assert.match(await readFile(result.files.markdown, "utf8"), /Provider-free/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("真实入口无确认时在读取配置前退出", async () => {
  await assert.rejects(
    execFileAsync("pnpm", ["exec", "tsx", "evals/tasks-real.ts"], { cwd: path.resolve(".") }),
    (error: unknown) => (error as { code?: number }).code === 2,
  );
});
