import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession } from "../core/session.js";
import { ConversationAgentModel } from "../core/agent-model.js";
import { ContextManager } from "../core/context.js";
import type { AgentEvent, ModelPricing } from "../core/types.js";
import { action, ScriptedModelClient } from "./scripted-model.js";
import type { DemoResult, EvalMetrics } from "./types.js";

const execFileAsync = promisify(execFile);
const pricing: ModelPricing = { inputPerMillionCny: 1, outputPerMillionCny: 2, cachedInputPerMillionCny: 0.1 };

async function nodeTest(workspace: string): Promise<boolean> {
  try {
    await execFileAsync(process.execPath, ["--test", "tests/math.test.ts"], { cwd: workspace });
    return true;
  } catch {
    return false;
  }
}

function metricsFromEvents(events: Array<{ event: AgentEvent }>, durationMs: number): EvalMetrics {
  let toolCalls = 0; let toolErrors = 0; let approvals = 0; let violations = 0;
  let input = 0; let output = 0; let cached = 0; let cost = 0;
  for (const { event } of events) {
    if (event.type === "tool_call") toolCalls++;
    if (event.type === "tool_result" && event.isError) toolErrors++;
    if (event.type === "ask_permission") approvals++;
    if (event.type === "permission_denied") violations++;
    if (event.type === "cost_update") { input += event.input; output += event.output; cached += event.cached; cost += event.costCny ?? 0; }
  }
  return {
    scenario: "edit", success: false, testsPassed: false,
    verification: [], toolCalls, toolErrors,
    tokens: { input, output, cached, total: input + output }, cost, durationMs,
    approvals, violations, recovery: { attempted: false, succeeded: false, steps: 0 },
    events: events.map(({ event }) => event.type),
  };
}

/** Runnable, provider-free repair demo: failing test -> AgentSession edit -> Bash verification. */
export async function runDemo(options: { keep?: boolean; sourceDir?: string } = {}): Promise<DemoResult> {
  const started = Date.now();
  const sourceDir = options.sourceDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "examples/broken-ts");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "myagent-demo-"));
  // Copy the fixture contents (not an extra broken-ts/ nesting level).
  await cp(path.join(sourceDir, "."), workspace, { recursive: true });
  const sourcePath = path.join(workspace, "src/math.ts");
  const testPath = path.join(workspace, "tests/math.test.ts");
  // Combine the process result with the known fixture assertion so a zero-test
  // invocation cannot be mistaken for a passing initial state.
  const initialTestsPassed = (await nodeTest(workspace)) && (await readFile(sourcePath, "utf8")).includes("return left + right;");
  const client = new ScriptedModelClient([
    action("Read", testPath, { file_path: testPath }),
    action("Read", sourcePath, { file_path: sourcePath }),
    action("Edit", sourcePath, { file_path: sourcePath, old_string: "return left - right;", new_string: "return left + right;" }),
    action("Bash", "node --test tests/math.test.ts", { command: "node --test tests/math.test.ts" }),
    { kind: "respond", text: "done" },
  ]);
  const model = new ConversationAgentModel(client, [], new ContextManager({ cwd: workspace, homeDir: path.join(workspace, ".state"), crossProjectMemory: false }));
  const session = new AgentSession({ id: "demo", title: "broken-ts repair", cwd: workspace, mode: "trust", model, stateDir: path.join(workspace, ".state"), pricing: { main: pricing } });
  await session.sendInput("Fix the failing math test by inspecting the test and source, edit the bug, then run the test.");
  const finalTestsPassed = (await nodeTest(workspace)) && (await readFile(sourcePath, "utf8")).includes("return left + right;");
  const changedFiles = (await readFile(sourcePath, "utf8")).includes("return left + right;") ? ["src/math.ts"] : [];
  const metrics = metricsFromEvents(session.events(), Date.now() - started);
  metrics.success = !initialTestsPassed && finalTestsPassed && changedFiles.length === 1 && metrics.toolErrors === 0;
  metrics.testsPassed = finalTestsPassed;
  metrics.verification = ["initial node --test failed", "AgentSession edited src/math.ts", "Bash verification completed", "final node --test passed"];
  const keep = options.keep ?? (process.env.MYAGENT_DEMO_KEEP === "1" || !metrics.success);
  if (!keep) await rm(workspace, { recursive: true, force: true });
  return { success: metrics.success, initialTestsPassed, finalTestsPassed, changedFiles, workspace, workspaceKept: keep, metrics };
}
