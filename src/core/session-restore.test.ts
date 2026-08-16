import assert from "node:assert/strict";
import test from "node:test";
import { TaskBox, type RunTaskOptions } from "./run-task.js";
import {
  firstUserText,
  interruptedTaskFrom,
  resumePrompt,
} from "./session-restore.js";
import type { AgentEvent, RecordedEvent } from "./types.js";

function record(seq: number, event: AgentEvent): RecordedEvent {
  return {
    seq,
    ts: "2026-08-16T00:00:00.000Z",
    sessionId: "s-test",
    branchId: "main",
    event,
  };
}

function userEvent(text: string): AgentEvent {
  return { type: "user", text };
}

type RunStartedOptions = NonNullable<
  Extract<AgentEvent, { type: "run_started" }>["taskOptions"]
>;

function runStarted(
  taskId: string,
  description: string,
  taskOptions?: Partial<RunStartedOptions>,
): AgentEvent {
  return {
    type: "run_started",
    taskId,
    description,
    permissionMode: "normal",
    hardRules: [],
    ...(taskOptions
      ? {
          taskOptions: {
            description,
            hardRules: [],
            semanticBounds: [],
            ...taskOptions,
          },
        }
      : {}),
  };
}

function runFinished(taskId: string): AgentEvent {
  return { type: "run_finished", taskId, status: "completed" };
}

test("firstUserText：取首条 user 消息并归一空白", () => {
  const records = [
    record(1, userEvent("  第一行\n  第二行  ")),
    record(2, userEvent("第二条")),
  ];
  assert.equal(firstUserText(records), "第一行 第二行");
});

test("firstUserText：无 user 消息返回 undefined", () => {
  const records = [record(1, runStarted("t1", "任务"))];
  assert.equal(firstUserText(records), undefined);
  assert.equal(firstUserText([]), undefined);
});

test("firstUserText：超 80 字符截断加省略号", () => {
  const longText = "长".repeat(100);
  const records = [record(1, userEvent(longText))];
  const result = firstUserText(records);
  assert.equal(result?.length, 81);
  assert.ok(result?.endsWith("…"));
  assert.equal(result?.slice(0, 80), "长".repeat(80));
});

test("interruptedTaskFrom：最近 run_started 无配对 finished 视为中断任务", () => {
  const records = [
    record(1, runStarted("t1", "任务一")),
    record(2, runFinished("t1")),
    record(3, runStarted("t2", "任务二")),
  ];
  const result = interruptedTaskFrom(records);
  assert.equal(result?.taskId, "t2");
  assert.equal(result?.description, "任务二");
});

test("interruptedTaskFrom：全部配对则无中断任务", () => {
  const records = [
    record(1, runStarted("t1", "任务一")),
    record(2, runFinished("t1")),
  ];
  assert.equal(interruptedTaskFrom(records), undefined);
});

test("interruptedTaskFrom：带任务选项时回传完整选项", () => {
  const records = [
    record(1, runStarted("t3", "任务三", { goal: "pnpm test 全过", budgetCny: 5 })),
  ];
  const result = interruptedTaskFrom(records);
  assert.equal(result?.taskId, "t3");
  assert.equal(result?.options?.goal, "pnpm test 全过");
  assert.equal(result?.options?.budgetCny, 5);
  assert.equal(result?.options?.description, "任务三");
});

test("interruptedTaskFrom：空/undefined 记录返回 undefined", () => {
  assert.equal(interruptedTaskFrom(undefined), undefined);
  assert.equal(interruptedTaskFrom([]), undefined);
});

function makeTaskBox(
  description: string,
  extra: Partial<RunTaskOptions> = {},
): TaskBox {
  return new TaskBox(
    {
      description,
      hardRules: [],
      semanticBounds: [],
      ...extra,
    },
    0,
    "box123",
  );
}

test("resumePrompt：含任务说明、验收目标与续跑指令", () => {
  const box = makeTaskBox("修复登录测试", { goal: "npm test 通过" });
  const prompt = resumePrompt(box, 0);
  assert.match(prompt, /\[任务续跑 #box123\]/);
  assert.match(prompt, /修复登录测试/);
  assert.match(prompt, /机器验收目标：npm test 通过/);
  assert.match(prompt, /先评估已完成的进度/);
});

test("resumePrompt：预算按已花费扣减且不为负", () => {
  const box = makeTaskBox("任务", { budgetCny: 10 });
  const prompt = resumePrompt(box, 4);
  assert.match(prompt, /本任务剩余预算：¥6\.00/);
  const exhausted = resumePrompt(box, 12);
  assert.match(exhausted, /本任务剩余预算：¥0\.00/);
});

test("resumePrompt：无 goal 与预算时不输出对应行", () => {
  const box = makeTaskBox("任务");
  const prompt = resumePrompt(box, 0);
  // 未指定 goal 时输出"未指定"说明（对应行存在但无具体目标）；预算行不输出
  assert.match(prompt, /机器验收目标：未指定/);
  assert.doesNotMatch(prompt, /剩余预算/);
});
