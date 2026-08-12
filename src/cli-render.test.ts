import assert from "node:assert/strict";
import test from "node:test";
import { createEventRenderer, summarizeEvent } from "./cli-render.js";

/** 渲染器输出收集器：注入 output 回调断言文本行（纯函数无 DOM 依赖） */
function renderer() {
  const lines: string[] = [];
  const render = createEventRenderer({
    output: (text) => lines.push(text),
    approvalState: { pendingCallId: "" },
    showCacheMissNotices: false,
  });
  return { lines, render };
}

test("ledger_update：每文件一行实时增量（status 徽标 + 相对路径）", () => {
  const { lines, render } = renderer();
  render({
    type: "ledger_update",
    taskId: "t1",
    unit: {
      id: "src/a.ts",
      kind: "file",
      label: "src/a.ts",
      status: "done",
      updatedAt: "2026-08-09T10:00:00.000Z",
    },
  });
  render({
    type: "ledger_update",
    taskId: "t1",
    unit: {
      id: "src/b.ts",
      kind: "file",
      label: "src/b.ts",
      status: "in_progress",
      updatedAt: "2026-08-09T10:00:00.000Z",
    },
  });
  render({
    type: "ledger_update",
    taskId: "t1",
    unit: {
      id: "notes.md",
      kind: "file",
      label: "notes.md",
      status: "blocked",
      updatedAt: "2026-08-09T10:00:00.000Z",
    },
  });
  assert.deepEqual(lines, ["  ✓ src/a.ts\n", "  → src/b.ts\n", "  ✗ notes.md\n"]);
});

test("ledger_update：pending / verified 徽标与 summarizeEvent 摘要", () => {
  const { lines, render } = renderer();
  render({
    type: "ledger_update",
    taskId: "t1",
    unit: {
      id: "x.md",
      kind: "file",
      label: "x.md",
      status: "verified",
      updatedAt: "2026-08-09T10:00:00.000Z",
    },
  });
  render({
    type: "ledger_update",
    taskId: "t1",
    unit: {
      id: "y.md",
      kind: "file",
      label: "y.md",
      status: "pending",
      updatedAt: "2026-08-09T10:00:00.000Z",
    },
  });
  assert.deepEqual(lines, ["  ✔ x.md\n", "  ○ y.md\n"]);
  assert.equal(
    summarizeEvent({
      type: "ledger_update",
      taskId: "t1",
      unit: {
        id: "x.md",
        kind: "file",
        label: "x.md",
        status: "done",
        updatedAt: "2026-08-09T10:00:00.000Z",
      },
    }),
    "账本：#t1 x.md（done）",
  );
});
