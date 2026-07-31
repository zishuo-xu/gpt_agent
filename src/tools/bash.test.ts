import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runBash } from "./bash.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessDeath(
  pid: number,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
}

async function readChildPid(pidFile: string): Promise<number | undefined> {
  for (let i = 0; i < 40; i += 1) {
    const text = await readFile(pidFile, "utf8").catch(() => "");
    if (text) return Number(text);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

function longRunningCommand(pidFile: string): string {
  return `${process.execPath} -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"`;
}

test("Abort 会先 kill 子进程再以 AbortError 拒绝", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-bash-"));
  const pidFile = path.join(directory, "child.pid");
  const controller = new AbortController();
  const running = runBash(longRunningCommand(pidFile), {
    cwd: directory,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(running, { name: "AbortError" });

  const pid = await readChildPid(pidFile);
  assert.ok(pid, "子进程应已启动并记录 pid");
  assert.equal(
    await waitForProcessDeath(pid),
    true,
    "abort 后子进程应被 kill，不得残留",
  );
});

test("Bash 超时也会 kill 子进程并以 AbortError 拒绝", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-bash-timeout-"));
  const pidFile = path.join(directory, "child.pid");
  const running = runBash(longRunningCommand(pidFile), {
    cwd: directory,
    timeoutMs: 100,
  });
  await assert.rejects(running, { name: "AbortError" });

  const pid = await readChildPid(pidFile);
  assert.ok(pid, "子进程应已启动并记录 pid");
  assert.equal(
    await waitForProcessDeath(pid),
    true,
    "超时后子进程应被 kill，不得残留",
  );
});

test("Bash 非零退出标记为错误并保留 stderr", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-bash-fail-"));
  const result = await runBash(
    `${process.execPath} -e "console.error('failed');process.exit(2)"`,
    { cwd: directory },
  );

  assert.equal(result.isError, true);
  assert.match(result.summary, /命令退出：2/);
  assert.match(
    String((result.output as { stderr: string }).stderr),
    /failed/,
  );
});
