#!/usr/bin/env node
import { runAllScenarios } from "../src/eval/harness.js";
import { createReport, writeReport } from "../src/eval/report.js";

const outputArg = process.argv.indexOf("--output");
const outputDir = outputArg >= 0 ? process.argv[outputArg + 1] : undefined;
const results = await runAllScenarios();
const report = createReport(results);
const files = await writeReport(report, outputDir ?? "tmp/eval");
console.log(JSON.stringify({ ...report.summary, files }, null, 2));
if (!report.summary.success) process.exitCode = 1;
