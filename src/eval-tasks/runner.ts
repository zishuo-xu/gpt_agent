import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentSession } from "../core/session.js";
import { ConversationAgentModel } from "../core/agent-model.js";
import { ContextManager } from "../core/context.js";
import { ScriptedModelClient } from "../eval/scripted-model.js";
import type { ModelClient } from "../model/types.js";
import { createTaskReport, writeTaskReport } from "./report.js";
import { DEV_TASK_SCENARIOS, scenarioById } from "./scenarios.js";
import type { DevTaskScenario, TaskEvalReport, TaskMode, TaskRunMetrics } from "./types.js";
import type { ModelPricing } from "../core/types.js";

const execFileAsync = promisify(execFile);
const pricing = { inputPerMillionCny: 1, outputPerMillionCny: 2, cachedInputPerMillionCny: 0.1 };

export interface TaskRunOptions {
  mode: TaskMode | "both";
  scenario?: string;
  outputDir: string;
  keep: boolean;
  kind?: TaskEvalReport["kind"];
  modelFactory?: (scenario: DevTaskScenario, cwd: string) => ModelClient;
  labels?: { provider?: string; model?: string };
  pricing?: ModelPricing;
}

export function classifyCompletion(options: {
  outcomePassed: boolean;
  runCompleted: boolean;
  mode: TaskMode;
  planUnits: TaskRunMetrics["planUnits"];
  expectedPlanUnits: number;
}): Pick<TaskRunMetrics, "declaredCompleted" | "reliableCompletion" | "falseCompletion"> {
  const planLedgerClosed = options.mode === "direct" || (
    options.planUnits.total === options.expectedPlanUnits
    && options.planUnits.pending === 0
    && options.planUnits.blocked === 0
    && options.planUnits.verified === options.planUnits.total
  );
  const reliableCompletion = options.outcomePassed && options.runCompleted && planLedgerClosed;
  return {
    declaredCompleted: options.runCompleted,
    reliableCompletion,
    falseCompletion: options.runCompleted && !reliableCompletion,
  };
}

function planText(scenario: DevTaskScenario): string {
  return [`## 目标`, scenario.description, ``, `## 执行步骤`, ...scenario.planSteps.map((step, index) => `${index + 1}. ${step}`), ``, `## 预计修改文件`, `- ${scenario.fixture}`, ``, `## 验证方式`, `- ${scenario.check}`, ``, `## 风险与待确认`, `- 保持现有公开行为，仅做本任务范围内的最小修改。`].join("\n");
}

function scriptedClient(scenario: DevTaskScenario, cwd: string, mode: TaskMode): ModelClient {
  const actions = scenario.prepare(cwd);
  const completion = [{ kind: "respond" as const, text: "PASS：任务完成，验收通过。" }, { kind: "respond" as const, text: "PASS：任务完成，验收通过。" }, { kind: "respond" as const, text: "PASS：任务完成，验收通过。" }];
  const steps = mode === "plan" ? [{ kind: "respond" as const, text: planText(scenario) }, ...actions.map((action) => ({ kind: "respond" as const, action })), ...completion] : [...actions.map((action) => ({ kind: "respond" as const, action })), ...completion];
  return new ScriptedModelClient(steps);
}

async function verify(cwd: string, check: string): Promise<{ passed: boolean; output: string }> {
  try {
    const result = await execFileAsync("sh", ["-c", check], { cwd, timeout: 30_000, maxBuffer: 2_000_000 });
    return { passed: true, output: `${result.stdout}${result.stderr}`.trim() };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return { passed: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}`.trim() };
  }
}

async function verifyScenarioShape(scenario: DevTaskScenario, cwd: string): Promise<boolean> {
  if (scenario.id === "cross-file-greeting") {
    const greeting = await readFile(path.join(cwd, "src/greeting.js"), "utf8");
    const index = await readFile(path.join(cwd, "src/index.js"), "utf8");
    return /function\s+greeting\s*\(\s*name\s*,/.test(greeting)
      && /greeting\s*\(\s*name\s*,\s*['"]!['"]\s*\)/.test(index);
  }
  if (scenario.id === "refactor-normalize") {
    const strings = await readFile(path.join(cwd, "src/strings.js"), "utf8");
    return strings.includes("normalizeForSearch")
      && strings.includes("normalizeForUrl")
      && (strings.match(/replaceAll/g) ?? []).length === 1;
  }
  return true;
}

function waitFor(session: AgentSession, predicate: (event: { event: { type: string } }) => boolean, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("任务验收等待超时")); }, timeoutMs);
    const unsubscribe = session.subscribe((record) => {
      if (!predicate(record)) return;
      clearTimeout(timer); unsubscribe(); resolve();
    });
  });
}

async function runOne(scenario: DevTaskScenario, mode: TaskMode, options: TaskRunOptions): Promise<TaskRunMetrics> {
  const started = Date.now();
  const workspace = await mkdtemp(path.join(os.tmpdir(), `myagent-dev-task-${scenario.id}-`));
  const fixture = path.resolve("examples/dev-tasks", scenario.fixture);
  await cp(fixture, workspace, { recursive: true });
  const model = options.modelFactory?.(scenario, workspace) ?? scriptedClient(scenario, workspace, mode);
  const session = new AgentSession({
    id: `dev-task-${Date.now().toString(36)}`,
    title: scenario.title,
    cwd: workspace,
    stateDir: path.join(workspace, ".state"),
    storageDir: path.join(workspace, ".session"),
    mode: "trust",
    model: new ConversationAgentModel(model, [], new ContextManager({ cwd: workspace, stateDir: path.join(workspace, ".state") })),
    pricing: { main: options.pricing ?? pricing },
    approvalTimeoutMs: 100,
  });
  let reliableCompletionForCleanup = false;
  try {
    if (mode === "plan") {
      const proposed = waitFor(session, (record) => record.event.type === "plan_proposed");
      const escapedCheck = scenario.check.replaceAll("'", `'\\''`);
      await session.startPlan(`/run ${scenario.description} --check '${escapedCheck}'`);
      await proposed;
      await session.decidePlan("approved");
      await waitFor(session, (record) => record.event.type === "run_finished");
    } else {
      await session.runTask({ description: scenario.title, goal: scenario.description, checks: [scenario.check], checkTimeoutMs: 30_000, hardRules: [], semanticBounds: [], permission: "trust" });
    }
    const checkResult = await verify(workspace, scenario.check);
    const shapePassed = await verifyScenarioShape(scenario, workspace);
    const outcomePassed = checkResult.passed && shapePassed;
    const verification = {
      command: scenario.check,
      commandPassed: checkResult.passed,
      shapePassed,
      output: checkResult.output.slice(-12_000),
    };
    const events = session.events();
    const startedEvent = events.find((record) => record.event.type === "run_started");
    const taskId = startedEvent?.event.type === "run_started" ? startedEvent.event.taskId : undefined;
    const ledger = taskId ? session.ledgerFor(taskId)?.snapshot().units ?? [] : [];
    const planLedger = ledger.filter((unit) => unit.kind === "task");
    const counts = { total: planLedger.length, completed: planLedger.filter((unit) => unit.status === "done").length, verified: planLedger.filter((unit) => unit.status === "verified").length, pending: planLedger.filter((unit) => unit.status === "pending" || unit.status === "in_progress").length, blocked: planLedger.filter((unit) => unit.status === "blocked").length };
    const input = events.filter((r) => r.event.type === "cost_update").reduce((sum, r) => sum + (r.event.type === "cost_update" ? r.event.input : 0), 0);
    const output = events.filter((r) => r.event.type === "cost_update").reduce((sum, r) => sum + (r.event.type === "cost_update" ? r.event.output : 0), 0);
    const cached = events.filter((r) => r.event.type === "cost_update").reduce((sum, r) => sum + (r.event.type === "cost_update" ? r.event.cached : 0), 0);
    const errors = events.filter((r) => (r.event.type === "tool_result" && r.event.isError) || r.event.type === "error").length;
    const terminal = events.findLast((r) => r.event.type === "run_finished");
    const runCompleted = terminal?.event.type === "run_finished" && terminal.event.status === "completed";
    const completion = classifyCompletion({
      outcomePassed,
      runCompleted,
      mode,
      planUnits: counts,
      expectedPlanUnits: scenario.planSteps.length,
    });
    reliableCompletionForCleanup = completion.reliableCompletion;
    const workspaceKept = options.keep || !completion.reliableCompletion;
    return { scenario: scenario.id, mode, outcomePassed, ...completion, interventions: events.filter((r) => r.event.type === "ask_permission" || r.event.type === "need_user").length, acceptanceAttempts: events.filter((r) => r.event.type === "acceptance_started").length, toolCalls: events.filter((r) => r.event.type === "tool_call").length, errors, tokens: { input, output, cached, total: input + output }, cost: events.filter((r) => r.event.type === "cost_update").reduce((sum, r) => sum + (r.event.type === "cost_update" ? r.event.costCny ?? 0 : 0), 0), durationMs: Date.now() - started, planUnits: counts, verification, ...(workspaceKept ? { workspace } : {}), workspaceKept };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { scenario: scenario.id, mode, outcomePassed: false, declaredCompleted: false, reliableCompletion: false, falseCompletion: false, interventions: 0, acceptanceAttempts: 0, toolCalls: session.events().filter((r) => r.event.type === "tool_call").length, errors: 1, tokens: { input: 0, output: 0, cached: 0, total: 0 }, cost: 0, durationMs: Date.now() - started, planUnits: { total: 0, completed: 0, verified: 0, pending: 0, blocked: 0 }, verification: { command: scenario.check, commandPassed: false, shapePassed: false, output: message }, workspace, workspaceKept: true, error: message };
  } finally {
    if (!options.keep) {
      if (reliableCompletionForCleanup) await rm(workspace, { recursive: true, force: true });
    }
  }
}

export async function runDevTaskEval(options: TaskRunOptions): Promise<{ report: TaskEvalReport; files: { json: string; markdown: string } }> {
  const scenarios = options.scenario ? [scenarioById(options.scenario)].filter((scenario): scenario is DevTaskScenario => Boolean(scenario)) : DEV_TASK_SCENARIOS;
  if (scenarios.length === 0) throw new Error(`未知任务场景：${options.scenario}`);
  const modes: TaskMode[] = options.mode === "both" ? ["direct", "plan"] : [options.mode];
  const runs: TaskRunMetrics[] = [];
  for (const scenario of scenarios) for (const mode of modes) runs.push(await runOne(scenario, mode, options));
  const report = createTaskReport(runs, options.kind ?? "provider-free-harness", options.labels);
  const files = await writeTaskReport(report, options.outputDir);
  return { report, files };
}
