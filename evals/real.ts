#!/usr/bin/env node
// 真实模型基准实测：与确定性 pnpm eval 同一套场景与指标，
// 区别仅在模型注入缝——用生效配置里的真实供应商客户端替换 ScriptedModelClient。
//
// 前置：Web 设置页已保存可用模型（main 角色首候选）并测试连接通过。
// 计费：真实 API 调用，11 个场景每次全量运行约几十个回合的 tokens 消耗；
// 成本列按配置单价（缺省回退内置价格表）估算。
import { runAllScenarios, runScenario } from "../src/eval/harness.js";
import { createReport, reportMarkdown, writeReport } from "../src/eval/report.js";
import { buildInjectedEvalOptions } from "../src/eval/real.js";

const outputArg = process.argv.indexOf("--output");
const outputDir = outputArg >= 0 ? process.argv[outputArg + 1] : undefined;
const scenarioArg = process.argv.indexOf("--scenario");
const scenarioFilter: string | undefined = scenarioArg >= 0 ? process.argv[scenarioArg + 1] : undefined;

let options;
try {
  options = await buildInjectedEvalOptions({ cwd: process.cwd() });
} catch (error) {
  console.error(`无法启动真实模型 Eval：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const { label } = options.injected;
console.log(`Eval REAL provider=${label.providerId} model=${label.model} pricing(in/out/cache per M CNY)=${options.injected.pricing.main.inputPerMillionCny}/${options.injected.pricing.main.outputPerMillionCny}/${options.injected.pricing.main.cachedInputPerMillionCny}`);

// --scenario 只跑指定场景（冒烟/控制成本）；全量跑分默认仍执行全部
if (scenarioFilter !== undefined) {
  const metrics = await runScenario(scenarioFilter as Parameters<typeof runScenario>[0], options);
  console.log(JSON.stringify(metrics, null, 1));
  if (!metrics.success) process.exitCode = 1;
} else {
  const results = await runAllScenarios(options);
  const report = createReport(results);
  const withLabel = {
    ...report,
    model: label,
  };
  const files = await writeReport(withLabel, outputDir ?? "tmp/eval-real");
  console.log(reportMarkdown(withLabel));
  console.log(JSON.stringify({ ...withLabel.summary, files }, null, 2));
  if (!report.summary.success) process.exitCode = 1;
}
