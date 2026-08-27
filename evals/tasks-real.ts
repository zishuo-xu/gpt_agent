#!/usr/bin/env node
import { runDevTaskEval } from "../src/eval-tasks/runner.js";

const args = process.argv.slice(2);
if (!args.includes("--confirm-cost")) {
  console.error("真实任务验收可能调用真实模型并产生费用；如需继续，请显式添加 --confirm-cost。未读取模型配置，也未发起网络请求。");
  process.exitCode = 2;
} else {
  const modeArg = args.indexOf("--mode");
  const mode = modeArg >= 0 ? args[modeArg + 1] : "both";
  if (mode !== "direct" && mode !== "plan" && mode !== "both") throw new Error("--mode 必须是 direct、plan 或 both");
  const scenarioArg = args.indexOf("--scenario");
  const scenario = scenarioArg >= 0 ? args[scenarioArg + 1] : undefined;
  const outputArg = args.indexOf("--output");
  const outputDir = outputArg >= 0 ? args[outputArg + 1] : "tmp/eval-tasks-real";
  const { buildInjectedEvalOptions } = await import("../src/eval/real.js");
  const injected = await buildInjectedEvalOptions({ cwd: process.cwd() });
  const result = await runDevTaskEval({ mode, ...(scenario ? { scenario } : {}), outputDir, keep: args.includes("--keep"), kind: "real-model", modelFactory: (_scenarioInfo, cwd) => injected.injected.createClient({ scenario: "read", cwd }), labels: { provider: injected.injected.label.providerId, model: injected.injected.label.model }, pricing: injected.injected.pricing.main });
  console.log(JSON.stringify({ ...result.report.summary, files: result.files }, null, 2));
  if (result.report.runs.some((run) => !run.reliableCompletion)) process.exitCode = 1;
}
