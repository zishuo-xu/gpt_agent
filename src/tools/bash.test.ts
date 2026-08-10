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

test("输出截断时全量 stdout/stderr 落盘并返回 fullOutputPath", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-bash-"));
  const payload = "A".repeat(100_000);
  const result = await runBash(
    `${process.execPath} -e "process.stdout.write('${payload}')"`,
    { cwd: directory, timeoutMs: 30_000 },
  );
  const details = result.details as Record<string, unknown>;
  assert.equal(typeof details.fullOutputPath, "string", "截断时应落盘全量输出");
  const full = await readFile(String(details.fullOutputPath), "utf8");
  assert.ok(full.includes(payload), "落盘内容应为全量输出");
  const output = result.output as { stdout: string; stderr: string };
  assert.ok(
    output.stdout.length < 200_000,
    "模型可见的 output 仍是截断版",
  );
  assert.match(String(result.summary), /完整输出/, "summary 提示完整输出路径");
});

test("未截断的输出不落盘", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-bash-"));
  const result = await runBash(`echo hello`, {
    cwd: directory,
    timeoutMs: 10_000,
  });
  const details = result.details as Record<string, unknown>;
  assert.equal(details.fullOutputPath, undefined);
});

function longRunningCommand(pidFile: string): string {
  return `${process.execPath} -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"`;
}

test("Abort 会 kill 子进程并返回已收集的部分输出", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-bash-"));
  const pidFile = path.join(directory, "child.pid");
  const controller = new AbortController();
  const running = runBash(
    `${process.execPath} -e "console.log('started'); require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"`,
    {
      cwd: directory,
      signal: controller.signal,
    },
  );
  setTimeout(() => controller.abort(), 400);
  const result = await running;
  assert.equal(result.aborted, true, "abort 应标记 aborted");
  assert.equal(result.isError, true);
  assert.match(
    String((result.output as { stdout: string }).stdout),
    /started/,
    "已收集的部分输出应保留，不因中止而丢弃",
  );

  const pid = await readChildPid(pidFile);
  assert.ok(pid, "子进程应已启动并记录 pid");
  assert.equal(
    await waitForProcessDeath(pid),
    true,
    "abort 后子进程应被 kill，不得残留",
  );
});

test("Bash 超时也会 kill 子进程并返回已收集的部分输出", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-bash-timeout-"));
  const pidFile = path.join(directory, "child.pid");
  // 超时需大于 node -e 冷启动时间（负载高时可达 200ms+），否则首行输出来不及产生
  const result = await runBash(
    `${process.execPath} -e "console.log('started'); require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"`,
    { cwd: directory, timeoutMs: 300 },
  );
  assert.equal(result.isError, true);
  assert.equal(
    (result.details as { timedOut?: boolean }).timedOut,
    true,
    "超时应在 details 标记 timedOut",
  );
  assert.match(
    String((result.output as { stdout: string }).stdout),
    /started/,
    "已收集的部分输出应保留",
  );

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

test("后台孙进程继承管道句柄时仍快速返回（不挂住）", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-bash-drain-"));
  const pidFile = path.join(directory, "grandchild.pid");
  // sh 退出后孙进程仍持有 stdout/stderr 管道句柄（参照 Pi 的 exec.ts 场景）
  const command = `${process.execPath} -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)" & echo done`;
  const startedAt = Date.now();
  const result = await runBash(command, {
    cwd: directory,
    timeoutMs: 60_000,
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed < 10_000,
    `应快速返回（实际 ${elapsed}ms），不得等待孙进程退出`,
  );
  assert.match(result.summary, /命令退出：0/);
  assert.match(result.summary, /输出可能不完整/);
  assert.match(String((result.output as { stdout: string }).stdout), /done/);

  // 清理后台孙进程，避免测试残留孤儿进程
  const pid = await readChildPid(pidFile);
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 进程已自行退出
    }
  }
});

test("孙进程持续输出时排空定时器随 data 续期，完整收集不截断", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-bash-renew-"));
  // sh 立即退出；孙进程每 300ms 输出一行共 10 行（约 3s，超过旧固定 2s 排空窗口）。
  // 排空定时器必须在 data 到达时续期，否则尾部输出被截断（参照 Pi waitForChildProcess）
  const command = `${process.execPath} -e "let i=0; const t=setInterval(()=>{console.log('line'+(i++)); if(i>=10) clearInterval(t)}, 300)" & echo done`;
  const startedAt = Date.now();
  const result = await runBash(command, {
    cwd: directory,
    timeoutMs: 60_000,
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed < 15_000,
    `应在排空窗口内返回（实际 ${elapsed}ms）`,
  );
  assert.match(result.summary, /命令退出：0/);
  assert.doesNotMatch(result.summary, /输出可能不完整/);
  const stdout = String((result.output as { stdout: string }).stdout);
  assert.match(stdout, /done/);
  assert.match(stdout, /line9/, "持续输出的尾部应被完整收集");
});

test("background 命令立即返回且进程在后台运行", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-bash-bg-"));
  const pidFile = path.join(directory, "bg.pid");
  const startedAt = Date.now();
  const result = await runBash(
    `${process.execPath} -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"`,
    { cwd: directory, background: true },
  );

  assert.equal(result.isError, false);
  assert.match(result.summary, /后台启动/);
  assert.ok(
    Date.now() - startedAt < 1500,
    "background 应立即返回而不等待命令结束",
  );
  const output = result.output as { pid: number };
  assert.ok(typeof output.pid === "number" && output.pid > 0);

  const pid = await readChildPid(pidFile);
  assert.ok(pid, "后台进程应真实启动并记录 pid");

  // 清理后台进程组，避免测试残留孤儿进程
  try {
    process.kill(-output.pid, "SIGTERM");
  } catch {
    // 进程已自行退出
  }
});

test("cleanupStaleBashLogs：仅清理超过保留期的 myagent-bash 落盘日志", async () => {
  const { mkdtemp, writeFile, utimes, readdir } = await import(
    "node:fs/promises"
  );
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-clean-"));
  const oldLog = path.join(dir, "myagent-bash-123-0.log");
  const freshLog = path.join(dir, "myagent-bash-123-1.log");
  const unrelated = path.join(dir, "other.log");
  await writeFile(oldLog, "old");
  await writeFile(freshLog, "fresh");
  await writeFile(unrelated, "keep");
  // 旧文件 mtime 拨回 10 天前
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  await utimes(oldLog, tenDaysAgo, tenDaysAgo);

  const { cleanupStaleBashLogs } = await import("./bash.js");
  await cleanupStaleBashLogs(7, dir);

  const remaining = (await readdir(dir)).sort();
  assert.deepEqual(remaining, ["myagent-bash-123-1.log", "other.log"]);
});

test("onData 回调实时收到输出分片，最终 tool_result 输出完整", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-ondata-"));
  const chunks: string[] = [];
  const result = await runBash("printf 'line1\\n'; printf 'line2\\n'", {
    cwd,
    onData: (chunk) => chunks.push(chunk),
  });
  assert.ok(chunks.length >= 1, "onData 应至少收到一次输出分片");
  assert.equal(chunks.join(""), "line1\nline2\n");
  // 最终结果完整（流式不影响 tool_result 内容）
  const stdout = (result.output as { stdout: string }).stdout;
  assert.equal(stdout, "line1\nline2\n");
});
