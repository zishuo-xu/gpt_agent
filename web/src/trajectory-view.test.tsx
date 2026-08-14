import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { buildTrajectoryTurns } from "./trajectory-view";

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
});
