import assert from "node:assert/strict";
import test from "node:test";
import { createReport, reportMarkdown } from "./report.js";
import { runAllScenarios, runScenario } from "./harness.js";
import { runDemo } from "./demo.js";

test("scripted eval covers deterministic harness scenarios", async () => {
  const results = await runAllScenarios();
  assert.equal(results.length, 11);
  assert.deepEqual(results.map((result) => result.scenario), [
    "read", "edit", "recovery", "deny", "approval", "cost", "budget", "replay", "branch", "acceptance", "flight",
  ]);
  assert.ok(results.every((result) => result.testsPassed));
  assert.ok(results.every((result) => result.tokens.total > 0));
  assert.ok(results.every((result) => result.durationMs >= 0));
  assert.ok(results.find((result) => result.toolErrors > 0));
  assert.ok(results.find((result) => result.violations > 0));
  assert.ok(results.find((result) => result.approvals > 0));
  assert.ok(results.find((result) => result.recovery.succeeded));
});

test("eval report has machine-readable and markdown projections", async () => {
  const result = await runScenario("cost");
  const report = createReport([result]);
  assert.equal(report.version, 1);
  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.passedScenarios, 1);
  assert.match(reportMarkdown(report), /MyAgent Harness Evaluation/);
  assert.match(reportMarkdown(report), /cost/);
});

test("broken-ts demo proves failing test, real session repair, and final pass", async () => {
  const result = await runDemo();
  assert.equal(result.initialTestsPassed, false);
  assert.equal(result.finalTestsPassed, true);
  assert.deepEqual(result.changedFiles, ["src/math.ts"]);
  assert.equal(result.workspaceKept, false);
  assert.equal(result.success, true);
});
