import assert from "node:assert/strict";
import test from "node:test";
import type { RecordedEvent } from "../core/types.js";
import { exportSessionHtml } from "./export-session.js";

function record(
  seq: number,
  event: RecordedEvent["event"],
): RecordedEvent {
  return {
    seq,
    ts: "2026-08-07T10:00:00.000Z",
    sessionId: "sess-1",
    branchId: "main",
    event,
  };
}

test("导出 HTML：标题/元信息/事件渲染齐全且转义", () => {
  const html = exportSessionHtml({
    sessionId: "sess-1",
    title: "修复 <bug> 任务",
    createdAt: "2026-08-07T09:00:00.000Z",
    updatedAt: "2026-08-07T10:00:00.000Z",
    permissionMode: "normal",
    records: [
      record(1, { type: "user", text: "帮我修复 & 测试" }),
      record(2, {
        type: "tool_call",
        call: {
          id: "c1",
          tool: "Read",
          target: "src/a.ts",
          args: { file_path: "src/a.ts" },
        },
      }),
      record(3, {
        type: "tool_result",
        callId: "c1",
        summary: "读取成功",
        output: "file content",
      }),
      record(4, { type: "done" }),
      record(5, { type: "label", seq: 2, name: "起点" }),
    ],
  });
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.match(html, /修复 &lt;bug&gt; 任务/, "标题转义");
  assert.match(html, /会话 #sess-1/);
  assert.match(html, /帮我修复 &amp; 测试/, "用户文本转义");
  assert.match(html, /<b>Read<\/b>/, "工具调用渲染");
  assert.match(html, /#1<\/span>/, "事件序号");
  assert.match(html, /🏁 任务完成/, "done 渲染");
  assert.match(html, /🔖 书签 #2「起点」/, "书签渲染");
  assert.ok(!html.includes("<script"), "无脚本注入面");
});

test("导出 HTML：diff 高亮与错误事件", () => {
  const html = exportSessionHtml({
    sessionId: "sess-2",
    title: "diff 测试",
    createdAt: "2026-08-07T09:00:00.000Z",
    updatedAt: "2026-08-07T10:00:00.000Z",
    permissionMode: "trust",
    records: [
      record(1, {
        type: "tool_result",
        callId: "e1",
        summary: "已修改 1 处",
        details: { diff: "+新增行\n-删除行\n不变行" },
      }),
      record(2, { type: "error", message: "模型超时" }),
    ],
  });
  assert.match(html, /class="add"/, "新增行高亮");
  assert.match(html, /class="del"/, "删除行高亮");
  assert.match(html, /class="event error"/, "错误事件样式");
  assert.match(html, /模型超时/);
});

test("导出 HTML：包含机器验收证据", () => {
  const html = exportSessionHtml({
    sessionId: "sess-acceptance",
    title: "验收",
    createdAt: "2026-08-07T09:00:00.000Z",
    updatedAt: "2026-08-07T10:00:00.000Z",
    permissionMode: "trust",
    records: [record(1, { type: "acceptance_started", taskId: "t1", attempt: 1, checks: ["pnpm test"] }), record(2, { type: "acceptance_result", taskId: "t1", attempt: 1, index: 0, command: "pnpm test", status: "passed", durationMs: 3, output: "all pass" })],
  });
  assert.match(html, /机器验收/);
  assert.match(html, /pnpm test/);
  assert.match(html, /all pass/);
});

test("导出 HTML：包含 Flight Recorder Fork 来源", () => {
  const html = exportSessionHtml({
    sessionId: "child-1",
    title: "实验",
    createdAt: "2026-08-07T09:00:00.000Z",
    updatedAt: "2026-08-07T10:00:00.000Z",
    permissionMode: "normal",
    records: [
      record(1, {
        type: "experiment_created",
        parentSessionId: "parent-1",
        parentTurnId: "turn-2",
        parentEventSeq: 10,
        providerId: "provider",
        model: "model",
        systemPromptOverlay: "替代策略",
      }),
    ],
  });
  assert.match(html, /Flight Recorder Fork/);
  assert.match(html, /parent-1/);
  assert.match(html, /provider\/model/);
  assert.match(html, /替代策略/);
});
