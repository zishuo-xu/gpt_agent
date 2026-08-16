import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireInstanceLock, isPidAlive } from "./instance-lock.js";

function lockPathIn(dir: string): string {
  return path.join(dir, "session.lock");
}

test("acquireInstanceLock：正常获取并写入 pid 信息", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-lock-"));
  await acquireInstanceLock(lockPathIn(dir), false);
  const parsed = JSON.parse(await readFile(lockPathIn(dir), "utf8")) as {
    pid: number;
  };
  assert.equal(parsed.pid, process.pid);
});

test("acquireInstanceLock：skip 时不创建锁文件", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-lock-"));
  await acquireInstanceLock(lockPathIn(dir), true);
  await assert.rejects(readFile(lockPathIn(dir), "utf8"), /ENOENT/);
});

test("acquireInstanceLock：持有者存活（本进程）时冲突报错", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-lock-"));
  await writeFile(
    lockPathIn(dir),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  await assert.rejects(acquireInstanceLock(lockPathIn(dir), false), /已被其他进程占用/);
});

test("acquireInstanceLock：崩溃残留（持有者已死）自动接管", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-lock-"));
  // 999999999 必然不存在的 pid（ESRCH）
  await writeFile(
    lockPathIn(dir),
    JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() }),
  );
  await acquireInstanceLock(lockPathIn(dir), false);
  const parsed = JSON.parse(await readFile(lockPathIn(dir), "utf8")) as {
    pid: number;
  };
  assert.equal(parsed.pid, process.pid, "接管后锁写入当前进程 pid");
});

test("acquireInstanceLock：坏锁（内容不可解析）自动接管", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-lock-"));
  await writeFile(lockPathIn(dir), "半写坏锁内容，不是 JSON");
  await acquireInstanceLock(lockPathIn(dir), false);
  const parsed = JSON.parse(await readFile(lockPathIn(dir), "utf8")) as {
    pid: number;
  };
  assert.equal(parsed.pid, process.pid);
});

test("isPidAlive：本进程存活，不存在 pid 判定已死", () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999_999_999), false);
});
