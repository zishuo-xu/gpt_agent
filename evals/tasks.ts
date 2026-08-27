#!/usr/bin/env node
import { runDevTaskEval } from "../src/eval-tasks/runner.js";

const args = process.argv.slice(2);
const modeArg = args.indexOf("--mode");
const mode = modeArg >= 0 ? args[modeArg + 1] : "both";
if (mode !== "direct" && mode !== "plan" && mode !== "both") throw new Error("--mode 必须是 direct、plan 或 both");
const scenarioArg = args.indexOf("--scenario");
const scenario = scenarioArg >= 0 ? args[scenarioArg + 1] : undefined;
const outputArg = args.indexOf("--output");
const outputDir = outputArg >= 0 ? args[outputArg + 1] : "tmp/eval-tasks";
const result = await runDevTaskEval({ mode, ...(scenario ? { scenario } : {}), outputDir, keep: args.includes("--keep") });
console.log(JSON.stringify({ ...result.report.summary, files: result.files }, null, 2));
if (result.report.runs.some((run) => !run.reliableCompletion)) process.exitCode = 1;
