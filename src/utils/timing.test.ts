import assert from "node:assert/strict";
import test from "node:test";
import { timingMark, timingReport } from "./timing.js";

test("timing：未开启 MYAGENT_TIMING 时无输出", () => {
  const previous = process.env.MYAGENT_TIMING;
  delete process.env.MYAGENT_TIMING;
  try {
    timingMark("配置加载");
    assert.equal(timingReport(), "");
  } finally {
    if (previous !== undefined) process.env.MYAGENT_TIMING = previous;
  }
});

test("timing：开启后输出各阶段耗时与总计", () => {
  const previous = process.env.MYAGENT_TIMING;
  process.env.MYAGENT_TIMING = "1";
  try {
    timingMark("配置加载");
    timingMark("restore");
    const report = timingReport();
    assert.match(report, /\[timing\] 启动总耗时 \d+ms/);
    assert.match(report, /配置加载: \d+ms/);
    assert.match(report, /restore: \d+ms/);
  } finally {
    if (previous !== undefined) process.env.MYAGENT_TIMING = previous;
    else delete process.env.MYAGENT_TIMING;
  }
});
