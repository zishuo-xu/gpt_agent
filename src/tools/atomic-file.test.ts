import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AtomicFileTools } from "./atomic-file.js";

async function fixture(content = "alpha\nbeta\n"): Promise<{
  directory: string;
  filePath: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-files-"));
  const filePath = path.join(directory, "sample.txt");
  await writeFile(filePath, content, "utf8");
  return { directory, filePath };
}

test("Edit 强制先 Read", async () => {
  const { filePath } = await fixture();
  const files = new AtomicFileTools();
  await assert.rejects(
    files.edit(filePath, "alpha", "omega"),
    /必须先 Read/,
  );
});

test("Edit 要求 old_string 唯一", async () => {
  const { filePath } = await fixture("same\nsame\n");
  const files = new AtomicFileTools();
  await files.read(filePath);
  await assert.rejects(
    files.edit(filePath, "same", "changed"),
    /匹配 2 处/,
  );
  assert.equal(await readFile(filePath, "utf8"), "same\nsame\n");
});

test("MultiEdit 任一项失败时不落下半成品", async () => {
  const { filePath } = await fixture();
  const files = new AtomicFileTools();
  await files.read(filePath);
  await assert.rejects(
    files.multiEdit(filePath, [
      { old_string: "alpha", new_string: "omega" },
      { old_string: "missing", new_string: "value" },
    ]),
    /未找到/,
  );
  assert.equal(await readFile(filePath, "utf8"), "alpha\nbeta\n");
});

test("EditJournal 只撤销仍处于 Agent 写入后状态的编辑", async () => {
  const { filePath } = await fixture();
  const files = new AtomicFileTools();
  await files.read(filePath);
  await files.edit(filePath, "alpha", "omega");
  assert.equal(await readFile(filePath, "utf8"), "omega\nbeta\n");
  assert.equal(await files.journal.rollbackLast(), true);
  assert.equal(await readFile(filePath, "utf8"), "alpha\nbeta\n");

  await files.edit(filePath, "alpha", "omega");
  await writeFile(filePath, "user changed\n", "utf8");
  assert.equal(await files.journal.rollbackLast(), false);
  assert.equal(await readFile(filePath, "utf8"), "user changed\n");
});

test("Abort 在提交前保留完整旧文件", async () => {
  const { filePath } = await fixture();
  const files = new AtomicFileTools();
  await files.read(filePath);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    files.edit(filePath, "alpha", "omega", false, controller.signal),
    { name: "AbortError" },
  );
  assert.equal(await readFile(filePath, "utf8"), "alpha\nbeta\n");
});

test("审批预览与最终 Edit 使用同一变换并包含三行上下文", async () => {
  const { filePath } = await fixture(
    ["one", "two", "three", "before", "five", "six", "seven"].join("\n"),
  );
  const files = new AtomicFileTools();
  await files.read(filePath);
  const preview = await files.previewEdit(
    filePath,
    "before",
    "after",
  );

  assert.match(preview, / one\n two\n three\n-before\n\+after\n five\n six\n seven/);

  await files.edit(filePath, "before", "after");
  assert.match(await readFile(filePath, "utf8"), /three\nafter\nfive/);
});

test("snapshot 注入：write/edit 提交前调用且携带旧内容", async () => {
  const { filePath } = await fixture();
  const calls: Array<{ file: string; before: string | null }> = [];
  const files = new AtomicFileTools(undefined, {
    snapshot: async (file, before) => {
      calls.push({ file, before });
    },
  });
  await files.read(filePath);
  await files.write(filePath, "新内容");
  await files.edit(filePath, "新内容", "更新");
  assert.equal(calls.length, 2);
  assert.equal(path.resolve(calls[0]!.file), path.resolve(filePath));
  assert.equal(calls[0]!.before, "alpha\nbeta\n");
  assert.equal(calls[1]!.before, "新内容");
});

test("同路径并发写互斥：快照延迟下无 lost update", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-lock-"));
  const file = path.join(directory, "x.txt");
  await writeFile(file, "A\n", "utf8");
  const files = new AtomicFileTools(undefined, {
    snapshot: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  });
  await files.read(file);
  // 无互斥时：两个 edit 都读到 "A\n"，第二个的 old_string "B" 未找到而抛错
  await Promise.all([
    files.edit(file, "A", "A\nB", undefined, undefined),
    files.edit(file, "B", "B\nC", undefined, undefined),
  ]);
  assert.equal(await readFile(file, "utf8"), "A\nB\nC\n");
});

test("不同路径并发写互不等待", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-lock-par-"));
  const fileA = path.join(directory, "a.txt");
  const fileB = path.join(directory, "b.txt");
  await writeFile(fileA, "A", "utf8");
  await writeFile(fileB, "B", "utf8");
  const files = new AtomicFileTools(undefined, {
    snapshot: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  });
  await files.read(fileA);
  await files.read(fileB);
  const startedAt = Date.now();
  await Promise.all([
    files.write(fileA, "A2"),
    files.write(fileB, "B2"),
  ]);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 180, `异路径写应并行（各 100ms 快照，实际 ${elapsed}ms）`);
});

test("锁等待期间 abort 快速失败，不执行写", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-lock-abort-"));
  const file = path.join(directory, "x.txt");
  await writeFile(file, "A", "utf8");
  const files = new AtomicFileTools(undefined, {
    snapshot: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  });
  await files.read(file);
  const slow = files.edit(file, "A", "A\nB", undefined, undefined);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const controller = new AbortController();
  const queued = files.edit(
    file,
    "A\nB",
    "A\nB\nC",
    undefined,
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(queued, { name: "AbortError" });
  await slow;
  assert.equal(await readFile(file, "utf8"), "A\nB");
});
