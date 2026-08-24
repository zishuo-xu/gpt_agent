import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../core/session.js";
import { ConversationAgentModel } from "../core/agent-model.js";
import { ContextManager } from "../core/context.js";
import type { AgentEvent, PermissionRule } from "../core/types.js";
import { action, ScriptedModelClient } from "./scripted-model.js";
import type { EvalMetrics, EvalOptions, EvalScenario, ScriptedStep } from "./types.js";
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

async function makeSession(cwd: string, stateDir: string, client: ScriptedModelClient, mode: "strict" | "normal" | "trust" = "trust", permissionRules: PermissionRule[] = []): Promise<AgentSession> {
  const model = new ConversationAgentModel(client, [], new ContextManager({ cwd, homeDir: stateDir, crossProjectMemory: false }));
  return new AgentSession({ id: `eval-${Math.random().toString(16).slice(2, 8)}`, title: "eval", cwd, mode, model, stateDir, permissionRules, pricing: { main: pricing }, approvalTimeoutMs: 50 });
}

export async function runScenario(scenario: EvalScenario, options: EvalOptions = {}): Promise<EvalMetrics> {
  const started = Date.now();
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-eval-"));
  const stateDir = path.join(root, "state");
  await writeFile(path.join(root, "fixture.txt"), "before\n", "utf8");
  const client = new ScriptedModelClient(stepsFor(scenario, root));
  const denyRules: PermissionRule[] = scenario === "deny" ? [{ effect: "deny", pattern: "Write(*.env)" }] : [];
  const mode = scenario === "approval" ? "normal" : (options.permissionMode ?? "trust");
  const session = await makeSession(root, stateDir, client, mode, denyRules);
  let recovery = { attempted: false, succeeded: false, steps: 0 };
  let verification: string[] = [];
  let branchCreated = false;
  let flightVerified = false;
  try {
    if (scenario === "budget") {
      await session.runTask({ description: "budget eval", goal: "read fixture", hardRules: [], semanticBounds: [], budgetCny: 0.00001, permission: "trust" });
      verification = ["run_finished(reason=budget) emitted"];
    } else if (scenario === "acceptance") {
      await session.runTask({ description: "acceptance eval", checks: ["printf acceptance-ok"], checkTimeoutMs: 1000, hardRules: [], semanticBounds: [], permission: "trust" });
      verification = ["acceptance_result passed emitted"];
    } else {
      await session.sendInput(`eval ${scenario}`);
      if (scenario === "replay") {
        const restored = await makeSession(root, stateDir, new ScriptedModelClient([{ kind: "respond", text: "done" }]));
        const restoredEvents = session.events().map((record) => ({ ...record, sessionId: restored.id }));
        // The restored session constructor path is exercised with the exact event stream.
        const restoredModel = new ConversationAgentModel(new ScriptedModelClient([{ kind: "respond", text: "done" }]), [], new ContextManager({ cwd: root, homeDir: stateDir, crossProjectMemory: false }));
        const replay = new AgentSession({ id: restored.id, title: "restored", cwd: root, mode: "trust", model: restoredModel, stateDir, restoredEvents, pricing: { main: pricing } });
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
          new ScriptedModelClient([
            action("Read", alternate, { file_path: alternate }),
            { kind: "respond", text: "done" },
          ]),
        );
        await child.sendInput("flight child");
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
        verification = [
          flightVerified
            ? `first divergence at tool index ${divergenceIndex}`
            : "flight diff did not identify the first divergence",
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
    const testsPassed = scenario === "read"
      ? session.summary().status === "done" && metrics.toolCalls === 1 && metrics.toolErrors === 0
      : scenario === "edit"
        ? verification[0] === "fixture edited" && session.summary().status === "done"
        : scenario === "recovery"
          ? recovery.succeeded && metrics.toolErrors === 1
          : scenario === "deny"
            ? metrics.violations === 1 && verification[0] === "denied .env was not created"
            : scenario === "approval"
              ? metrics.approvals === 1 && metrics.violations === 1 && verification[0] === "approval timed out and file was not created"
            : scenario === "cost"
              ? metrics.cost > 0 && metrics.tokens.total > 0
              : scenario === "budget"
                ? session.events().some((record) => record.event.type === "run_finished" && record.event.reason === "budget")
                : scenario === "acceptance"
                  ? session.events().some((record) => record.event.type === "acceptance_result" && record.event.status === "passed") && session.events().some((record) => record.event.type === "run_finished" && record.event.status === "completed")
                : scenario === "replay"
                  ? recovery.succeeded
                  : scenario === "branch"
                    ? branchCreated
                    : flightVerified;
    return { scenario, success: testsPassed, testsPassed, verification, durationMs: Date.now() - started, recovery, ...metrics };
  } catch (error) {
    const metrics = summarizeEvents(session.events());
    return { scenario, success: false, testsPassed: false, verification, durationMs: Date.now() - started, recovery, error: error instanceof Error ? error.message : String(error), ...metrics };
  }
}

export async function runAllScenarios(options: EvalOptions = {}): Promise<EvalMetrics[]> {
  const scenarios: EvalScenario[] = ["read", "edit", "recovery", "deny", "approval", "cost", "budget", "replay", "branch", "acceptance", "flight"];
  return Promise.all(scenarios.map((scenario) => runScenario(scenario, options)));
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}
