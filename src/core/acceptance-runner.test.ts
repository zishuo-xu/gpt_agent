import assert from "node:assert/strict";
import test from "node:test";
import { runAcceptanceChecks } from "./acceptance-runner.js";

test("acceptance runner marks timeout and continues all commands", async () => {
  const results = await runAcceptanceChecks({
    cwd: process.cwd(),
    // Core 全量测试会并发启动大量子进程；给第二条快速命令留足调度余量，
    // 同时让第一条稳定超过超时界限，避免把机器负载误判成产品失败。
    checks: ["sleep 3", "printf passed"],
    timeoutMs: 2_000,
  });
  assert.equal(results.length, 2);
  assert.equal(results[0]?.status, "timed_out");
  assert.equal(results[1]?.status, "passed");
});

test("acceptance runner reports non-zero exit code and recalculates deadline per command", async () => {
  const results = await runAcceptanceChecks({
    cwd: process.cwd(),
    checks: ["printf out; exit 3", "printf second"],
    timeoutMs: 5000,
  });
  assert.equal(results[0]?.status, "failed");
  assert.equal(results[0]?.exitCode, 3);
  assert.equal(results[1]?.status, "passed");
});

test("acceptance runner does not execute commands after deadline", async () => {
  const results = await runAcceptanceChecks({
    cwd: process.cwd(),
    checks: ["printf first", "printf second"],
    timeoutMs: 1000,
    deadlineAt: Date.now() - 1,
  });
  assert.deepEqual(results.map((result) => result.status), ["timed_out", "timed_out"]);
});
