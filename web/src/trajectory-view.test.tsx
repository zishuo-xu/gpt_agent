import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  buildTrajectoryTurns,
  formatDuration,
} from "./trajectory-view";
import { stripThoughtNotes } from "./session-display";

/** 构造一条事件（seq 自增） */
function record(
  seq: number,
  ts: string,
  event: Record<string, unknown>,
) {
  return { seq, ts, event } as never;
}

describe("buildTrajectoryTurns（轨迹回合分组）", () => {
  before(() => {
    GlobalRegistrator.register();
  });

  after(() => {
    GlobalRegistrator.unregister();
  });

  it("每轮完整链路：用户输入 → 推理合并 → 工具带结果 → 回复合并", () => {
    const turns = buildTrajectoryTurns([
      record(1, "2026-08-14T10:00:00.000Z", {
        type: "user",
        text: "修复 bug",
      }),
      record(2, "2026-08-14T10:00:01.000Z", {
        type: "thinking_delta",
        text: "The ",
      }),
      record(3, "2026-08-14T10:00:01.100Z", {
        type: "thinking_delta",
        text: "user has a bug",
      }),
      record(4, "2026-08-14T10:00:02.000Z", {
        type: "tool_call",
        call: {
          id: "call-1",
          tool: "Edit",
          target: "a.ts",
          args: { file_path: "a.ts", old_string: "x", new_string: "y" },
        },
      }),
      record(5, "2026-08-14T10:00:03.000Z", {
        type: "tool_result",
        callId: "call-1",
        summary: "已编辑 a.ts",
        details: { diff: "-x\n+y" },
      }),
      record(6, "2026-08-14T10:00:04.000Z", {
        type: "text_delta",
        text: "已修复，",
      }),
      record(7, "2026-08-14T10:00:04.100Z", {
        type: "text_delta",
        text: "测试通过。",
      }),
    ]);
    assert.equal(turns.length, 1);
    const turn = turns[0]!;
    assert.equal(turn.userText, "修复 bug");
    assert.equal(turn.thinking, "The user has a bug", "推理增量按回合合并");
    assert.equal(turn.reply, "已修复，测试通过。", "回复增量按回合合并");
    assert.equal(turn.tools.length, 1);
    assert.equal(turn.tools[0]!.name, "Edit", "工具名单独提取供 chips 展示");
    assert.match(turn.tools[0]!.title, /^Edit a\.ts$/);
    assert.match(turn.tools[0]!.detail, /参数：/);
    assert.match(turn.tools[0]!.detail, /结果：\n-x\n\+y/, "工具结果展示 diff");
  });

  it("用户消息开启新回合，轮次序号递增", () => {
    const turns = buildTrajectoryTurns([
      record(1, "2026-08-14T10:00:00.000Z", { type: "user", text: "第一问" }),
      record(2, "2026-08-14T10:00:01.000Z", {
        type: "text_delta",
        text: "回答一",
      }),
      record(3, "2026-08-14T10:00:02.000Z", { type: "user", text: "第二问" }),
      record(4, "2026-08-14T10:00:03.000Z", {
        type: "text_delta",
        text: "回答二",
      }),
    ]);
    assert.equal(turns.length, 2);
    assert.equal(turns[0]!.index, 1);
    assert.equal(turns[0]!.userText, "第一问");
    assert.equal(turns[0]!.reply, "回答一");
    assert.equal(turns[1]!.index, 2);
    assert.equal(turns[1]!.userText, "第二问");
    assert.equal(turns[1]!.reply, "回答二");
  });

  it("无结果的工具调用标注无返回", () => {
    const turns = buildTrajectoryTurns([
      record(1, "2026-08-14T10:00:00.000Z", { type: "user", text: "hi" }),
      record(2, "2026-08-14T10:00:01.000Z", {
        type: "tool_call",
        call: { id: "call-x", tool: "Bash", target: "rm -rf /", args: {} },
      }),
    ]);
    assert.equal(turns[0]!.tools.length, 1);
    assert.equal(turns[0]!.tools[0]!.name, "Bash");
    assert.match(turns[0]!.tools[0]!.detail, /无返回/);
  });

  it("Bash 对象型输出（stdout/stderr）序列化进结果", () => {
    const turns = buildTrajectoryTurns([
      record(1, "2026-08-14T10:00:00.000Z", { type: "user", text: "hi" }),
      record(2, "2026-08-14T10:00:01.000Z", {
        type: "tool_call",
        call: {
          id: "call-b",
          tool: "Bash",
          target: "echo hi",
          args: { command: "echo hi" },
        },
      }),
      record(3, "2026-08-14T10:00:02.000Z", {
        type: "tool_result",
        callId: "call-b",
        summary: "命令退出：0",
        output: { stdout: "hi\n", stderr: "", code: 0 },
      }),
    ]);
    const detail = turns[0]!.tools[0]!.detail;
    assert.match(detail, /"stdout": "hi\\n"/);
    assert.match(detail, /"code": 0/);
  });

  it("工具循环中间的过程文本不进回复，只保留最后一段", () => {
    const turns = buildTrajectoryTurns([
      record(1, "2026-08-14T10:00:00.000Z", { type: "user", text: "查股价" }),
      record(2, "2026-08-14T10:00:01.000Z", {
        type: "text_delta",
        text: "我来搜索一下。",
      }),
      record(3, "2026-08-14T10:00:02.000Z", {
        type: "tool_call",
        call: { id: "c1", tool: "WebSearch", target: "x", args: {} },
      }),
      record(4, "2026-08-14T10:00:03.000Z", {
        type: "tool_result",
        callId: "c1",
        summary: "ok",
      }),
      record(5, "2026-08-14T10:00:04.000Z", {
        type: "text_delta",
        text: "搜到了，再抓一下详情。",
      }),
      record(6, "2026-08-14T10:00:05.000Z", {
        type: "tool_call",
        call: { id: "c2", tool: "WebFetch", target: "y", args: {} },
      }),
      record(7, "2026-08-14T10:00:06.000Z", {
        type: "tool_result",
        callId: "c2",
        summary: "ok",
      }),
      record(8, "2026-08-14T10:00:07.000Z", {
        type: "text_delta",
        text: "最终分析：明天看涨。",
      }),
    ]);
    assert.equal(
      turns[0]!.reply,
      "最终分析：明天看涨。",
      "只保留最后一段，中间过程说明被丢弃",
    );
  });

  it("回合耗时与工具耗时：从事件时间戳计算", () => {
    const turns = buildTrajectoryTurns([
      record(1, "2026-08-14T10:00:00.000Z", { type: "user", text: "查股价" }),
      record(2, "2026-08-14T10:00:01.000Z", {
        type: "tool_call",
        call: { id: "c1", tool: "Bash", target: "slow", args: {} },
      }),
      record(3, "2026-08-14T10:00:05.500Z", {
        type: "tool_result",
        callId: "c1",
        summary: "done",
      }),
      record(4, "2026-08-14T10:00:07.000Z", {
        type: "text_delta",
        text: "查完了。",
      }),
    ]);
    const turn = turns[0]!;
    assert.equal(turn.durationMs, 7000, "回合耗时 = 最后事件 - 用户输入");
    assert.equal(
      turn.tools[0]!.durationMs,
      4500,
      "工具耗时 = tool_result - tool_call",
    );
    assert.equal(formatDuration(4500), "4.5s");
    assert.equal(formatDuration(7000), "7.0s");
    assert.equal(formatDuration(125000), "2m05s");
    assert.equal(formatDuration(undefined), "");
  });

  it("stripThoughtNotes：剥离 [思考过程] 标记及其后的英文思考，保留中文正式内容", () => {
    const input = `[思考过程]
Now run the conversion with node and verify the output.
第 4 步完成：sample.md 已创建。
[思考过程]
The user wants stdin support. Let me check the file.
增强完成，验证通过。`;
    assert.equal(
      stripThoughtNotes(input),
      "第 4 步完成：sample.md 已创建。\n增强完成，验证通过。",
    );
    assert.equal(stripThoughtNotes("纯中文回复，无思考标记。"), "纯中文回复，无思考标记。");
  });

  it("无用户消息的会话兜底归入一个回合", () => {
    const turns = buildTrajectoryTurns([
      record(1, "2026-08-14T10:00:01.000Z", {
        type: "text_delta",
        text: "只有回复",
      }),
    ]);
    assert.equal(turns.length, 1);
    assert.match(turns[0]!.userText, /无用户消息/);
    assert.equal(turns[0]!.reply, "只有回复");
  });

  it("子代理（task_start/task_end）并入工具阶段，name 为 Task", () => {
    const turns = buildTrajectoryTurns([
      record(1, "2026-08-14T10:00:00.000Z", { type: "user", text: "派子代理" }),
      record(2, "2026-08-14T10:00:01.000Z", {
        type: "task_start",
        taskId: "t-1",
        description: "搜索鉴权代码",
      }),
      record(3, "2026-08-14T10:00:05.000Z", {
        type: "task_end",
        taskId: "t-1",
        summary: "找到 3 处",
        status: "completed",
      }),
    ]);
    assert.equal(turns[0]!.tools.length, 1);
    assert.equal(turns[0]!.tools[0]!.name, "Task");
    assert.match(turns[0]!.tools[0]!.title, /子代理：搜索鉴权代码/);
    assert.equal(turns[0]!.tools[0]!.status, "ok", "task_end 完成 → ok");
  });
});
