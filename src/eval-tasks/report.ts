import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TaskEvalReport, TaskRunMetrics, TaskMode } from "./types.js";

export function createTaskReport(runs: TaskRunMetrics[], kind: TaskEvalReport["kind"], labels: { provider?: string; model?: string } = {}): TaskEvalReport {
  const total = runs.length || 1;
  const byMode = (mode: TaskMode) => {
    const selected = runs.filter((run) => run.mode === mode);
    const divisor = selected.length || 1;
    return {
      total: selected.length,
      outcomePassed: selected.filter((run) => run.outcomePassed).length,
      reliableCompletion: selected.filter((run) => run.reliableCompletion).length,
      interventions: selected.reduce((sum, run) => sum + run.interventions, 0),
      acceptanceAttempts: selected.reduce((sum, run) => sum + run.acceptanceAttempts, 0),
      averageTokens: selected.reduce((sum, run) => sum + run.tokens.total, 0) / divisor,
      averageCost: selected.reduce((sum, run) => sum + run.cost, 0) / divisor,
      averageDurationMs: selected.reduce((sum, run) => sum + run.durationMs, 0) / divisor,
    };
  };
  return {
    version: 1, kind, generatedAt: new Date().toISOString(), fixtureRevision: "dev-tasks-v1",
    ...(labels.provider ? { provider: labels.provider } : {}), ...(labels.model ? { model: labels.model } : {}), runs,
    summary: {
      taskCompletionRate: runs.filter((run) => run.outcomePassed).length / total,
      reliableCompletionRate: runs.filter((run) => run.reliableCompletion).length / total,
      falseCompletionCount: runs.filter((run) => run.falseCompletion).length,
      interventionCount: runs.reduce((sum, run) => sum + run.interventions, 0),
      byMode: { direct: byMode("direct"), plan: byMode("plan") },
    },
  };
}

export function taskReportMarkdown(report: TaskEvalReport): string {
  const mode = report.kind === "provider-free-harness" ? "Provider-free（仅验证 Harness，不代表模型智能）" : `真实模型${report.provider ? `：${report.provider}/${report.model ?? ""}` : ""}`;
  const modeRows = (["direct", "plan"] as const).map((name) => {
    const value = report.summary.byMode[name];
    return `| ${name} | ${value.reliableCompletion}/${value.total} | ${value.interventions} | ${value.acceptanceAttempts} | ${value.averageTokens.toFixed(0)} | ${value.averageCost.toFixed(4)} | ${value.averageDurationMs.toFixed(0)} |`;
  });
  return [`# MyAgent Dev Task Evaluation`, ``, `模式：${mode}`, `Fixture revision：${report.fixtureRevision}`, ``, `任务完成率：${(report.summary.taskCompletionRate * 100).toFixed(1)}%`, `可靠完成率：${(report.summary.reliableCompletionRate * 100).toFixed(1)}%`, `错误完成声明：${report.summary.falseCompletionCount}`, `人工介入次数：${report.summary.interventionCount}`, ``, `## Direct / Plan 对比`, ``, `| Mode | Reliable | Interventions | Acceptance | Avg tokens | Avg cost | Avg duration ms |`, `|---|---:|---:|---:|---:|---:|---:|`, ...modeRows, ``, `## Runs`, ``, `| Scenario | Mode | Outcome | Reliable | False completion | Tools | Errors | Acceptance | Duration |`, `|---|---|---:|---:|---:|---:|---:|---:|---:|`, ...report.runs.map((run) => `| ${run.scenario} | ${run.mode} | ${run.outcomePassed ? "PASS" : "FAIL"} | ${run.reliableCompletion ? "yes" : "no"} | ${run.falseCompletion ? "yes" : "no"} | ${run.toolCalls} | ${run.errors} | ${run.acceptanceAttempts} | ${run.durationMs} |`), ``].join("\n");
}

export async function writeTaskReport(report: TaskEvalReport, outputDir: string): Promise<{ json: string; markdown: string }> {
  await mkdir(outputDir, { recursive: true });
  const json = path.resolve(outputDir, "report.json");
  const markdown = path.resolve(outputDir, "report.md");
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdown, `${taskReportMarkdown(report)}\n`, "utf8");
  return { json, markdown };
}
