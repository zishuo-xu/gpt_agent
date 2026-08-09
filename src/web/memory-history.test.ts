import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryHistoryKeeper } from "./memory-history.js";

async function fixture(): Promise<{
  root: string;
  memDir: string;
  keeper: MemoryHistoryKeeper;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-mhistory-"));
  const memDir = path.join(root, ".myagent", "memory");
  await mkdir(memDir, { recursive: true });
  return {
    root,
    memDir,
    keeper: new MemoryHistoryKeeper([path.join(memDir, "pitfalls.md")]),
  };
}

test("留档：命中记忆路径时旧内容写入同目录 .history/，新建文件不留档", async () => {
  const { root, memDir, keeper } = await fixture();
  const target = path.join(memDir, "pitfalls.md");
  await writeFile(target, "旧内容", "utf8");
  await keeper.snapshot(target, "旧内容");
  await keeper.snapshot(target, null); // 新建文件场景：无旧内容，不留档
  const files = await readdir(path.join(memDir, ".history"));
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^pitfalls-\d{8}-\d{6}-\d{3}-[0-9a-f]{4}\.md$/);
  assert.equal(
    await readFile(path.join(memDir, ".history", files[0]!), "utf8"),
    "旧内容",
  );
  await rm(root, { recursive: true, force: true });
});

test("留档：非记忆路径不产生任何副作用（不建 .history 目录）", async () => {
  const { root, memDir, keeper } = await fixture();
  await keeper.snapshot(path.join(root, "src", "main.ts"), "内容");
  await assert.rejects(readdir(path.join(memDir, ".history"))); // ENOENT
  await rm(root, { recursive: true, force: true });
});

test("留档：每文档上限 50 份，超限删除最旧", async () => {
  const { root, memDir, keeper } = await fixture();
  const target = path.join(memDir, "pitfalls.md");
  for (let i = 0; i < 55; i++) await keeper.snapshot(target, `v${i}`);
  const files = (await readdir(path.join(memDir, ".history"))).sort();
  assert.equal(files.length, 50);
  // 文件名 ts 前缀字典序 = 时间序：保留的是最后 50 份
  assert.ok(
    files.every((file) => {
      const match = /^pitfalls-\d{8}-\d{6}-\d{3}-[0-9a-f]{4}\.md$/.exec(file);
      return match !== null;
    }),
  );
  await rm(root, { recursive: true, force: true });
});
