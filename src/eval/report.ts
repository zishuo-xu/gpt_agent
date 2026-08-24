import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvalReport } from "./types.js";

export function createReport(scenarios: EvalReport["scenarios"]): EvalReport {
  const passed = scenarios.filter((scenario) => scenario.success).length;
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    scenarios,
    summary: {
      success: passed === scenarios.length,
      passedScenarios: passed,
      total: scenarios.length,
      totalTokens: scenarios.reduce((sum, s) => sum + s.tokens.total, 0),
      totalCost: roundCost(scenarios.reduce((sum, s) => sum + s.cost, 0)),
      totalDurationMs: scenarios.reduce((sum, s) => sum + s.durationMs, 0),
    },
  };
}

export function reportMarkdown(report: EvalReport): string {
  const rows = report.scenarios.map((s) =>
    `| ${s.scenario} | ${s.success ? "PASS" : "FAIL"} | ${s.toolCalls} | ${s.toolErrors} | ${s.tokens.total} | ${s.cost.toFixed(6)} | ${s.durationMs} | ${s.approvals} | ${s.violations} | ${s.recovery.succeeded ? "yes" : "no"} |`,
  );
  return [
    "# MyAgent Harness Evaluation",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Result: **${report.summary.success ? "PASS" : "FAIL"}** (${report.summary.passedScenarios}/${report.summary.total})`,
    "",
    "| Scenario | Result | Tool calls | Tool errors | Tokens | Cost (CNY) | Duration (ms) | Approvals | Violations | Recovery |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows,
    "",
  ].join("\n");
}

function roundCost(value: number): number {
  return Number(value.toFixed(6));
}

export async function writeReport(report: EvalReport, outputDir = "tmp/eval"): Promise<{ json: string; markdown: string }> {
  await mkdir(outputDir, { recursive: true });
  const json = path.resolve(outputDir, "report.json");
  const markdown = path.resolve(outputDir, "report.md");
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdown, reportMarkdown(report), "utf8");
  return { json, markdown };
}
