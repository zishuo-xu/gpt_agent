/**
 * trace 分析器：扫描会话 trace 文件，统计 diff 占比 / bash 截断率 / 缓存命中率，
 * 为"diff 是否移出 LLM 上下文"等决策提供真实数据（参照 Pi 的 cache-stats 度量精神）。
 *
 * 用法：
 *   pnpm exec tsx scripts/analyze-traces.ts [trace 文件或目录...]
 * 缺省扫描 ~/.myagent/projects 下各项目 sessions 目录中的 trace 文件
 */
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTurnTrace } from "../src/core/events.js";
import { aggregateTraces } from "../src/stats/trace-stats.js";

async function collectTraceFiles(args: string[]): Promise<string[]> {
  if (args.length > 0) {
    const files: string[] = [];
    for (const arg of args) {
      const stat = await import("node:fs/promises").then((fs) =>
        fs.stat(arg).catch(() => undefined),
      );
      if (!stat) continue;
      if (stat.isFile()) files.push(arg);
      if (stat.isDirectory()) {
        for (const name of await readdir(arg)) {
          if (name.endsWith(".trace.jsonl")) {
            files.push(path.join(arg, name));
          }
        }
      }
    }
    return files;
  }
  const projectsDir = path.join(os.homedir(), ".myagent", "projects");
  const files: string[] = [];
  const projectKeys = await readdir(projectsDir).catch(() => [] as string[]);
  for (const key of projectKeys) {
    const sessionsDir = path.join(projectsDir, key, "sessions");
    for (const name of await readdir(sessionsDir).catch(() => [] as string[])) {
      if (name.endsWith(".trace.jsonl")) {
        files.push(path.join(sessionsDir, name));
      }
    }
  }
  return files;
}

function percent(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatBytes(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}KB`;
  return `${value}B`;
}

async function main(): Promise<void> {
  const files = await collectTraceFiles(process.argv.slice(2));
  if (files.length === 0) {
    console.log("未找到 trace 文件。");
    return;
  }
  const totals = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    editCalls: 0,
    diffTotalChars: 0,
    bashCalls: 0,
    bashTruncated: 0,
    bashOutputIncomplete: 0,
  };
  console.log(
    [
      "会话".padEnd(14),
      "轮数".padStart(5),
      "input".padStart(9),
      "缓存率".padStart(7),
      "Edit次数".padStart(8),
      "diff 字节".padStart(10),
      "diff/输入".padStart(9),
      "bash".padStart(5),
      "截断".padStart(5),
      "不完整".padStart(6),
    ].join(" "),
  );
  for (const file of files) {
    const content = await readFile(file, "utf8").catch(() => "");
    const traces = content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AgentTurnTrace);
    const stats = aggregateTraces(traces);
    totals.turns += stats.turns;
    totals.inputTokens += stats.inputTokens;
    totals.outputTokens += stats.outputTokens;
    totals.cachedTokens += stats.cachedTokens;
    totals.editCalls += stats.editCalls;
    totals.diffTotalChars += stats.diffTotalChars;
    totals.bashCalls += stats.bashCalls;
    totals.bashTruncated += stats.bashTruncated;
    totals.bashOutputIncomplete += stats.bashOutputIncomplete;
    console.log(
      [
        path.basename(file, ".trace.jsonl").slice(0, 14).padEnd(14),
        String(stats.turns).padStart(5),
        String(stats.inputTokens).padStart(9),
        percent(stats.cacheRate).padStart(7),
        String(stats.editCalls).padStart(8),
        formatBytes(stats.diffTotalChars).padStart(10),
        percent(stats.diffCharsPerInputChar).padStart(9),
        String(stats.bashCalls).padStart(5),
        String(stats.bashTruncated).padStart(5),
        String(stats.bashOutputIncomplete).padStart(6),
      ].join(" "),
    );
  }
  console.log(
    [
      "合计".padEnd(14),
      String(totals.turns).padStart(5),
      String(totals.inputTokens).padStart(9),
      percent(
        totals.inputTokens > 0
          ? totals.cachedTokens / totals.inputTokens
          : null,
      ).padStart(7),
      String(totals.editCalls).padStart(8),
      formatBytes(totals.diffTotalChars).padStart(10),
      percent(
        totals.inputTokens > 0
          ? totals.diffTotalChars / (totals.inputTokens * 4)
          : null,
      ).padStart(9),
      String(totals.bashCalls).padStart(5),
      String(totals.bashTruncated).padStart(5),
      String(totals.bashOutputIncomplete).padStart(6),
    ].join(" "),
  );
}

void main();
