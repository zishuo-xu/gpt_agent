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
      { oldString: "alpha", newString: "omega" },
      { oldString: "missing", newString: "value" },
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
  const { directory, filePath } = await fixture();
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
