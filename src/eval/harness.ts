import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../core/session.js";
import { ConversationAgentModel } from "../core/agent-model.js";
import { ContextManager } from "../core/context.js";
import type { AgentEvent, PermissionRule } from "../core/types.js";
import { action, ScriptedModelClient } from "./scripted-model.js";
import type { EvalMetrics, EvalOptions, EvalScenario, ScriptedStep } from "./types.js";
import type { ModelClient } from "../model/types.js";
import { computeExperimentDiff } from "../core/experiment-diff.js";
import type { ExperimentSessionMeta } from "../core/experiment.js";

const pricing = { inputPerMillionCny: 1, outputPerMillionCny: 2, cachedInputPerMillionCny: 0.1 };

function stepsFor(scenario: EvalScenario, cwd: string): ScriptedStep[] {
  const file = path.join(cwd, "fixture.txt");
  switch (scenario) {
    case "read":
      return [action("Read", file, { file_path: file }), { kind: "respond", text: "done" }];
    case "edit":
      return [
        action("Read", file, { file_path: file }),
        action("Edit", file, { file_path: file, old_string: "before", new_string: "after" }),
        { kind: "respond", text: "done" },
      ];
    case "recovery":
      return [
        action("Read", path.join(cwd, "missing.txt"), { file_path: path.join(cwd, "missing.txt") }),
        action("Read", file, { file_path: file }),
        { kind: "respond", text: "done" },
      ];
    case "deny":
      return [action("Write", path.join(cwd, ".env"), { file_path: path.join(cwd, ".env"), content: "SECRET=bad" }), { kind: "respond", text: "done" }];
    case "approval":
      return [action("Write", path.join(cwd, "approval.txt"), { file_path: path.join(cwd, "approval.txt"), content: "approval" }), { kind: "respond", text: "done" }];
    case "cost":
    case "budget":
    case "replay":
    case "branch":
      return [action("Read", file, { file_path: file }), { kind: "respond", text: "done" }];
    case "acceptance":
      return [action("Read", file, { file_path: file }), { kind: "respond", text: "done" }];
    case "flight":
      return [action("Read", file, { file_path: file }), { kind: "respond", text: "done" }];
  }
}

/** 注入真实模型时使用的自然语言指令：语义对齐各场景的 Harness 意图，
    让模型行为收敛到可核验的结果，而非复刻脚本的精确工具序列。 */
function instructionFor(scenario: EvalScenario): string {
  switch (scenario) {
    case "read":
      return "用 Read 工具读取 fixture.txt，然后一句话汇报它的内容。";
    case "edit":
      return "先把 fixture.txt 读出来，再把其中出现的 \"before\" 改成 \"after\"。";
    case "recovery":
      return "先尝试读取 missing.txt；无论该步是否报错，随后读取 fixture.txt 并汇报内容。";
    case "deny":
      return "创建文件 .env，内容写一行 SECRET=bad。";
    case "approval":
      return "创建文件 approval.txt，内容写一行 approval。";
    case "cost":
      return "用 Read 工具读取 fixture.txt。";
    default:
      return `eval ${scenario}`;
  }
}

function summarizeEvents(events: Array<{ event: AgentEvent }>): Pick<EvalMetrics, "toolCalls" | "toolErrors" | "tokens" | "cost" | "approvals" | "violations" | "events"> {
  let input = 0; let output = 0; let cached = 0; let cost = 0;
  let toolCalls = 0; let toolErrors = 0; let approvals = 0; let violations = 0;
  for (const { event } of events) {
    if (event.type === "tool_call") toolCalls++;
    if (event.type === "tool_result" && event.isError) toolErrors++;
    if (event.type === "cost_update") { input += event.input; output += event.output; cached += event.cached; cost += event.costCny ?? 0; }
    if (event.type === "ask_permission") approvals++;
    if (event.type === "permission_denied") violations++;
  }
  return { toolCalls, toolErrors, tokens: { input, output, cached, total: input + output }, cost, approvals, violations, events: events.map(({ event }) => event.type) };
}

async function makeSession(cwd: string, stateDir: string, client: ModelClient, mode: "strict" | "normal" | "trust" = "trust", permissionRules: PermissionRule[] = [], sessionPricing: { main: typeof pricing } = { main: pricing }): Promise<AgentSession> {
  const model = new ConversationAgentModel(client, [], new ContextManager({ cwd, homeDir: stateDir, crossProjectMemory: false }));
  return new AgentSession({ id: `eval-${Math.random().toString(16).slice(2, 8)}`, title: "eval", cwd, mode, model, stateDir, permissionRules, pricing: sessionPricing, approvalTimeoutMs: 50 });
}

export async function runScenario(scenario: EvalScenario, options: EvalOptions = {}): Promise<EvalMetrics> {
  const started = Date.now();
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-eval-"));
  const stateDir = path.join(root, "state");
  await writeFile(path.join(root, "fixture.txt"), "before\n", "utf8");
  const injectedPricing = options.injected?.pricing.main;
  const effectivePricing = injectedPricing ?? pricing;
  const newClient = (): ModelClient =>
    options.injected ? options.injected.createClient({ scenario, cwd: root }) : new ScriptedModelClient(stepsFor(scenario, root));
  const sessionFor = (mode2: "strict" | "normal" | "trust", rules: PermissionRule[] = []): Promise<AgentSession> =>
    makeSession(root, stateDir, newClient(), mode2, rules, { main: effectivePricing });
  const denyRules: PermissionRule[] = scenario === "deny" ? [{ effect: "deny", pattern: "Write(*.env)" }] : [];
  const mode = scenario === "approval" ? "normal" : (options.permissionMode ?? "trust");
  const session = await sessionFor(mode, denyRules);
  let recovery = { attempted: false, succeeded: false, steps: 0 };
  let verification: string[] = [];
  let branchCreated = false;
  let flightVerified = false;
  let flightDiffed = false;
  try {
    if (scenario === "budget") {
      await session.runTask({ description: "budget eval", goal: "read fixture", hardRules: [], semanticBounds: [], budgetCny: 0.00001, permission: "trust" });
      verification = ["run_finished(reason=budget) emitted"];
    } else if (scenario === "acceptance") {
      await session.runTask({ description: "acceptance eval", checks: ["printf acceptance-ok"], checkTimeoutMs: 1000, hardRules: [], semanticBounds: [], permission: "trust" });
      verification = ["acceptance_result passed emitted"];
    } else {
      await session.sendInput(options.injected ? instructionFor(scenario) : `eval ${scenario}`);
      if (scenario === "replay") {
        const restored = await sessionFor("trust");
        const restoredEvents = session.events().map((record) => ({ ...record, sessionId: restored.id }));
        // The restored session constructor path is exercised with the exact event stream.
        const restoredModel = new ConversationAgentModel(newClient(), [], new ContextManager({ cwd: root, homeDir: stateDir, crossProjectMemory: false }));
        const replay = new AgentSession({ id: restored.id, title: "restored", cwd: root, mode: "trust", model: restoredModel, stateDir, restoredEvents, pricing: { main: effectivePricing } });
        recovery = { attempted: true, succeeded: replay.events().length === session.events().length, steps: replay.events().length };
        verification = [`replayed ${replay.events().length} events (constructor replay; not disk restore)`];
      } else if (scenario === "recovery") {
        recovery = { attempted: true, succeeded: session.events().some((r) => r.event.type === "tool_result" && r.event.isError === true) && session.summary().status === "done", steps: 2 };
        verification = ["error event followed by successful tool result"];
      } else if (scenario === "branch") {
        const seq = session.events().find((r) => r.event.type === "user")?.seq ?? 1;
        const branch = session.forkBranch(seq, "eval branch");
        branchCreated = branch !== "main" && session.branches().length === 2;
        verification = [`branch ${branch} created`];
      } else if (scenario === "flight") {
        const alternate = path.join(root, "alternate.txt");
        await writeFile(alternate, "alternate\n", "utf8");
        const child = await makeSession(
          root,
          stateDir,
          options.injected
            ? options.injected.createClient({ scenario, cwd: root })
            : new ScriptedModelClient([
                action("Read", alternate, { file_path: alternate }),
                { kind: "respond", text: "done" },
              ]),
          "trust",
          [],
          { main: effectivePricing },
        );
        await child.sendInput(options.injected ? "读取 alternate.txt 并汇报内容，然后结束。" : "flight child");
        const meta = (model: string, overlay?: string): ExperimentSessionMeta => ({
          version: 1,
          parentSessionId: session.id,
          parentTurnId: "eval-turn",
          parentEventSeq: 1,
          projectCwd: root,
          workspaceSnapshot: {
            worktreePath: root,
            cwd: root,
            gitRoot: root,
            head: "eval",
            untrackedCopied: [],
            warnings: [],
          },
          pinnedModel: { providerId: "scripted", model },
          ...(overlay ? { systemPromptOverlay: overlay } : {}),
          status: "ready",
          createdAt: new Date().toISOString(),
        });
        const diff = computeExperimentDiff(
          { meta: meta("parent"), traces: await session.traces() },
          { meta: meta("child", "alternate strategy"), traces: await child.traces() },
        );
        const divergenceIndex = diff.tools.firstDivergence?.index;
        flightVerified =
          diff.model.changed &&
          diff.overlay.changed &&
          divergenceIndex === 0;
        flightDiffed = diff.model.changed && diff.overlay.changed;
        verification = [
          options.injected
            ? (flightDiffed
              ? `parent/child differ in model and overlay; first divergence at tool index ${divergenceIndex ?? "none"}`
              : "flight diff missing model or overlay change")
            : (flightVerified
              ? `first divergence at tool index ${divergenceIndex}`
              : "flight diff did not identify the first divergence"),
        ];
      }
    }
    if (scenario === "edit") verification = [(await readFile(path.join(root, "fixture.txt"), "utf8")).includes("after") ? "fixture edited" : "fixture unchanged"];
    if (scenario === "deny") verification = [!(await exists(path.join(root, ".env"))) ? "denied .env was not created" : ".env unexpectedly created"];
    if (scenario === "approval") verification = [
      !(await exists(path.join(root, "approval.txt")))
        ? "approval timed out and file was not created"
        : "approval file unexpectedly created",
    ];
    if (scenario === "read") verification = ["read completed"];
    if (scenario === "cost") verification = ["cost_update emitted"];
    const metrics = summarizeEvents(session.events());
    // 真实模式按"结果证据"判定（模型不会复刻脚本的精确工具序列）；
    // 确定性模式保持精确计数断言，负责回归钉死 Harness 行为。
    const done = session.summary().status === "done";
    const testsPassed = options.injected
      ? scenario === "read"
        ? done && metrics.toolCalls >= 1 && metrics.toolErrors === 0
        : scenario === "edit"
          ? verification[0] === "fixture edited"
          : scenario === "recovery"
            ? recovery.succeeded && metrics.toolCalls >= 2
            : scenario === "deny"
              ? metrics.violations >= 1 && verification[0] === "denied .env was not created"
              : scenario === "approval"
                ? metrics.approvals >= 1 && verification[0] === "approval timed out and file was not created"
                : scenario === "cost"
                  ? metrics.cost > 0 && metrics.tokens.total > 0
                  : scenario === "flight"
                    ? flightDiffed
                    : /* budget/replay/branch/acceptance 为机械性构造，两模式同判 */
                      deterministicPassed(scenario, { recovery, branchCreated, flightVerified, events: session.events() })
      : deterministicPassed(scenario, { recovery, branchCreated, flightVerified, events: session.events(), done, metrics, verification });
    return { scenario, success: testsPassed, testsPassed, verification, durationMs: Date.now() - started, recovery, ...metrics };
  } catch (error) {
    const metrics = summarizeEvents(session.events());
    return { scenario, success: false, testsPassed: false, verification, durationMs: Date.now() - started, recovery, error: error instanceof Error ? error.message : String(error), ...metrics };
  }
}

/** 确定性模式的通过条件：精确工具计数 + 事件序列断言，钉死 Harness 行为不漂移。 */
function deterministicPassed(
  scenario: EvalScenario,
  ctx: {
    recovery: { attempted: boolean; succeeded: boolean; steps: number };
    branchCreated: boolean;
    flightVerified: boolean;
    events: Array<{ event: AgentEvent }>;
    done?: boolean;
    metrics?: Pick<EvalMetrics, "toolCalls" | "toolErrors" | "tokens" | "cost" | "approvals" | "violations">;
    verification?: string[];
  },
): boolean {
  const { recovery, branchCreated, flightVerified, events, done, metrics, verification } = ctx;
  const has = (predicate: (event: AgentEvent) => boolean) => events.some((record) => predicate(record.event));
  switch (scenario) {
    case "read":
      return done === true && metrics?.toolCalls === 1 && metrics?.toolErrors === 0;
    case "edit":
      return verification?.[0] === "fixture edited" && done === true;
    case "recovery":
      return recovery.succeeded && metrics?.toolErrors === 1;
    case "deny":
      return metrics?.violations === 1 && verification?.[0] === "denied .env was not created";
    case "approval":
      return metrics?.approvals === 1 && metrics?.violations === 1 && verification?.[0] === "approval timed out and file was not created";
    case "cost":
      return (metrics?.cost ?? 0) > 0 && (metrics?.tokens.total ?? 0) > 0;
    case "budget":
      return has((event) => event.type === "run_finished" && event.reason === "budget");
    case "acceptance":
      return has((event) => event.type === "acceptance_result" && event.status === "passed") && has((event) => event.type === "run_finished" && event.status === "completed");
    case "replay":
      return recovery.succeeded;
    case "branch":
      return branchCreated;
    case "flight":
      return flightVerified;
  }
}

export async function runAllScenarios(options: EvalOptions = {}): Promise<EvalMetrics[]> {
  const scenarios: EvalScenario[] = ["read", "edit", "recovery", "deny", "approval", "cost", "budget", "replay", "branch", "acceptance", "flight"];
  return Promise.all(scenarios.map((scenario) => runScenario(scenario, options)));
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}
