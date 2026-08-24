#!/usr/bin/env node
import { runDemo } from "../src/eval/demo.js";

const result = await runDemo({ keep: process.env.MYAGENT_DEMO_KEEP === "1" });
console.log(JSON.stringify(result, null, 2));
if (!result.success) process.exitCode = 1;
