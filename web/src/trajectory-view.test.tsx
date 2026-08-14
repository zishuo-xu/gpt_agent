import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { buildTrajectoryRows } from "./trajectory-view";

/** 构造一条事件（seq 自增） */
function record(
  seq: number,
  ts: string,
  event: Record<string, unknown>,
) {
  return { seq, ts, event } as never;
}

describe("buildTrajectoryRows（轨迹表格步骤行）", () => {
  before(() => {
    GlobalRegistrator.register();
  });

  after(() => {
    GlobalRegistrator.unregister();
  });

  it("连续的 thinking_delta 合并为单个推理步骤（完整内容）", () => {
    const rows = buildTrajectoryRows([
      record(1, "2026-08-14T10:00:00.000Z", {
        type: "user",
        text: "你好",
      }),
      record(2, "2026-08-14T10:00:01.000Z", {
        type: "thinking_delta",
        text: "The ",
      }),
      record(3, "2026-08-14T10:00:01.100Z", {
        type: "thinking_delta",
        text: "user greets",
      }),
      record(4, "2026-08-14T10:00:01.200Z", {
        type: "text_delta",
        text: "你好！",
      }),
      record(5, "2026-08-14T10:00:01.300Z", {
        type: "text_delta",
        text: "有什么可以帮你？",
      }),
    ]);
    const thinking = rows.filter((row) => row.lane === "thinking");
    assert.equal(thinking.length, 1, "32 个增量块应合并为 1 个推理步骤");
    assert.equal(thinking[0]?.detail, "The user greets");
    const messages = rows.filter((row) => row.lane === "message");
    assert.equal(messages.length, 2, "提问 + 回复各一行");
    assert.equal(messages[1]?.detail, "你好！有什么可以帮你？");
    assert.match(messages[1]?.title ?? "", /^回复：你好！/);
  });

  it("工具调用配对 tool_result 展示结果（diff 优先）", () => {
    const rows = buildTrajectoryRows([
      record(1, "2026-08-14T10:00:00.000Z", {
        type: "tool_call",
        call: {
          id: "call-1",
          tool: "Edit",
          target: "a.ts",
          args: { file_path: "a.ts", old_string: "x", new_string: "y" },
        },
      }),
      record(2, "2026-08-14T10:00:01.000Z", {
        type: "tool_result",
        callId: "call-1",
        summary: "已编辑 a.ts",
        details: { diff: "-x\n+y" },
      }),
    ]);
    const tool = rows.filter((row) => row.lane === "tool");
    assert.equal(tool.length, 1);
    assert.match(tool[0]?.detail ?? "", /参数：/);
    assert.match(tool[0]?.detail ?? "", /结果：\n-x\n\+y/, "diff 应展示");
    assert.ok(
      !(tool[0]?.detail ?? "").includes("无返回"),
      "有结果时不应标注无返回",
    );
  });

  it("无结果的工具调用标注无返回", () => {
    const rows = buildTrajectoryRows([
      record(1, "2026-08-14T10:00:00.000Z", {
        type: "tool_call",
        call: { id: "call-x", tool: "Bash", target: "rm -rf /", args: {} },
      }),
    ]);
    const tool = rows.filter((row) => row.lane === "tool");
    assert.equal(tool.length, 1);
    assert.match(tool[0]?.detail ?? "", /无返回/);
  });

  it("Bash 对象型输出（stdout/stderr）序列化进结果", () => {
    const rows = buildTrajectoryRows([
      record(1, "2026-08-14T10:00:00.000Z", {
        type: "tool_call",
        call: {
          id: "call-b",
          tool: "Bash",
          target: "echo hi",
          args: { command: "echo hi" },
        },
      }),
      record(2, "2026-08-14T10:00:01.000Z", {
        type: "tool_result",
        callId: "call-b",
        summary: "命令退出：0",
        output: { stdout: "hi\n", stderr: "", code: 0 },
      }),
    ]);
    const tool = rows.filter((row) => row.lane === "tool");
    assert.match(tool[0]?.detail ?? "", /"stdout": "hi\\n"/);
    assert.match(tool[0]?.detail ?? "", /"code": 0/);
  });

  it("用户提问与系统事件各自成行", () => {
    const rows = buildTrajectoryRows([
      record(1, "2026-08-14T10:00:00.000Z", { type: "user", text: "hi" }),
      record(2, "2026-08-14T10:00:01.000Z", {
        type: "run_started",
        taskId: "t1",
        description: "任务",
        hardRules: [],
      }),
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.lane, "message");
    assert.equal(rows[1]?.lane, "system");
    assert.equal(rows[1]?.title, "run_started");
  });
});
