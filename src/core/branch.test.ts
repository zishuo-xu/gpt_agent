import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConversationAgentModel } from "../model/agent-model.js";
import type {
  CompletionRequest,
  ConversationMessage,
  ModelClient,
  ModelResponse,
} from "../model/types.js";
import {
  ROOT_BRANCH,
  branchChain,
  branchesFromEvents,
  conversationFrom,
  currentBranchIdFrom,
  filterRecordsForBranch,
  type BranchEventLike,
} from "./branch.js";
import { AgentSession } from "./session.js";

function event(
  seq: number,
  event: BranchEventLike["event"],
  branchId?: string,
): BranchEventLike {
  return {
    seq,
    ts: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    ...(branchId ? { branchId } : {}),
    event,
  };
}

test("branchesFromEvents：无分支事件时只有 main 根分支", () => {
  const branches = branchesFromEvents([
    event(1, { type: "user", text: "hi" }),
    event(2, { type: "done" }),
  ]);
  assert.deepEqual(branches, [
    {
      id: ROOT_BRANCH,
      parent: null,
      forkSeq: null,
      createdAt: branches[0]?.createdAt,
    },
  ]);
  assert.equal(branches[0]?.id, "main");
  assert.equal(branches[0]?.parent, null);
});

test("branchesFromEvents：从 branch_switch 事件重建分支（label/forkSeq 透传）", () => {
  const branches = branchesFromEvents([
    event(1, { type: "user", text: "hi" }),
    event(
      2,
      {
        type: "branch_switch",
        branchId: "ab12cd",
        parent: ROOT_BRANCH,
        forkSeq: 1,
        label: "方案B",
      },
      "ab12cd",
    ),
    event(3, { type: "user", text: "继续", queueId: undefined }, "ab12cd"),
  ]);
  assert.equal(branches.length, 2);
  assert.deepEqual(branches[1], {
    id: "ab12cd",
    parent: "main",
    forkSeq: 1,
    label: "方案B",
    createdAt: new Date(2026, 0, 1, 0, 0, 2).toISOString(),
  });
});

test("currentBranchIdFrom：无分支返回 main，多分支取最后一个", () => {
  assert.equal(currentBranchIdFrom([event(1, { type: "user", text: "a" })]), "main");
  assert.equal(
    currentBranchIdFrom([
      event(1, { type: "user", text: "a" }),
      event(
        2,
        { type: "branch_switch", branchId: "b1", parent: "main", forkSeq: 1 },
        "b1",
      ),
      event(3, { type: "user", text: "b" }, "b1"),
      event(
        4,
        { type: "branch_switch", branchId: "b2", parent: "b1", forkSeq: 3 },
        "b2",
      ),
    ]),
    "b2",
  );
});

test("branchChain：沿 parent 链收集祖先分支（含自身）", () => {
  const branches = branchesFromEvents([
    event(
      1,
      { type: "branch_switch", branchId: "b1", parent: "main", forkSeq: 1 },
      "b1",
    ),
    event(
      2,
      { type: "branch_switch", branchId: "b2", parent: "b1", forkSeq: 2 },
      "b2",
    ),
  ]);
  const chain = branchChain(branches, "b2");
  assert.deepEqual(
    chain.map((branch) => branch.id),
    ["main", "b1", "b2"],
  );
});

test("filterRecordsForBranch：祖先事件 + 本分支事件，兄弟分支剔除", () => {
  const records = [
    event(1, { type: "user", text: "开场" }),
    event(
      2,
      { type: "branch_switch", branchId: "b1", parent: "main", forkSeq: 1 },
      "b1",
    ),
    event(3, { type: "user", text: "分支1" }, "b1"),
    event(
      4,
      { type: "branch_switch", branchId: "b2", parent: "main", forkSeq: 1 },
      "b2",
    ),
    event(5, { type: "user", text: "分支2" }, "b2"),
  ];
  const branches = branchesFromEvents(records);
  const filtered = filterRecordsForBranch(records, branches, "b1");
  assert.deepEqual(
    filtered.map((record) => record.seq),
    [1, 2, 3],
  );
  const filteredB2 = filterRecordsForBranch(records, branches, "b2");
  assert.deepEqual(
    filteredB2.map((record) => record.seq),
    [1, 4, 5],
  );
});

test("conversationFrom：分支视角重建消息，跳过 branch_switch 与兄弟分支", () => {
  const records = [
    event(1, { type: "user", text: "开场" }),
    event(2, { type: "text_delta", text: "回答开场" }),
    event(
      3,
      { type: "branch_switch", branchId: "b1", parent: "main", forkSeq: 2 },
      "b1",
    ),
    event(4, { type: "user", text: "走分支1" }, "b1"),
    event(5, { type: "text_delta", text: "回答分支1" }, "b1"),
    event(
      6,
      { type: "branch_switch", branchId: "b2", parent: "main", forkSeq: 2 },
      "b2",
    ),
    event(7, { type: "user", text: "走分支2" }, "b2"),
    event(8, { type: "text_delta", text: "回答分支2" }, "b2"),
  ];
  const branches = branchesFromEvents(records);
  const messages = conversationFrom(records, branches, "b1");
  assert.deepEqual(messages, [
    { role: "user", content: "开场" },
    { role: "assistant", content: "回答开场", toolCalls: [] },
    { role: "user", content: "走分支1" },
    { role: "assistant", content: "回答分支1", toolCalls: [] },
  ]);
});

test("conversationFrom：无分支参数时回退到当前分支视角（旧会话兼容）", () => {
  const records = [
    event(1, { type: "user", text: "开场" }),
    event(2, { type: "text_delta", text: "回答" }),
  ];
  const messages = conversationFrom(records);
  assert.deepEqual(messages, [
    { role: "user", content: "开场" },
    { role: "assistant", content: "回答", toolCalls: [] },
  ]);
});

test("conversationFrom：压缩摘要与分支过滤组合（压缩先于分支）", () => {
  const records = [
    event(1, { type: "user", text: "问题1" }),
    event(2, { type: "text_delta", text: "回答1" }),
    event(3, { type: "user", text: "问题2" }),
    event(4, { type: "text_delta", text: "回答2" }),
    event(5, {
      type: "context_compacted",
      summary: "前两轮摘要",
      ratio: 0.5,
      keepFromSeq: 3,
    }),
    event(6, { type: "user", text: "问题3" }),
    event(7, { type: "text_delta", text: "回答3" }),
    event(
      8,
      { type: "branch_switch", branchId: "b1", parent: "main", forkSeq: 7 },
      "b1",
    ),
    event(9, { type: "user", text: "分支问题" }, "b1"),
    event(10, { type: "text_delta", text: "分支回答" }, "b1"),
  ];
  const branches = branchesFromEvents(records);
  const messages = conversationFrom(records, branches, "b1");
  assert.deepEqual(messages, [
    { role: "user", content: "[会话压缩摘要]\n前两轮摘要" },
    { role: "user", content: "问题2" },
    { role: "assistant", content: "回答2", toolCalls: [] },
    { role: "user", content: "问题3" },
    { role: "assistant", content: "回答3", toolCalls: [] },
    { role: "user", content: "分支问题" },
    { role: "assistant", content: "分支回答", toolCalls: [] },
  ]);
});

test("conversationFrom：tool_call/tool_result 配对且结果归属分支链", () => {
  const call = {
    id: "call-1",
    tool: "Read",
    target: "/tmp/a.txt",
    args: {},
  };
  const records = [
    event(1, { type: "user", text: "读文件" }),
    event(2, { type: "tool_call", call }),
    event(3, {
      type: "tool_result",
      callId: "call-1",
      summary: "内容",
      output: "file body",
    }),
    event(
      4,
      { type: "branch_switch", branchId: "b1", parent: "main", forkSeq: 3 },
      "b1",
    ),
    event(5, { type: "user", text: "继续" }, "b1"),
  ];
  const branches = branchesFromEvents(records);
  const messages = conversationFrom(records, branches, "b1");
  assert.deepEqual(messages[1], {
    role: "assistant",
    content: "",
    toolCalls: [call],
  });
  assert.deepEqual(messages[2], {
    role: "tool",
    toolCallId: "call-1",
    toolName: "Read",
    target: "/tmp/a.txt",
    content: "内容\nfile body",
    isError: false,
  });
});

class ScriptedClient implements ModelClient {
  readonly requests: CompletionRequest[] = [];
  readonly #responses: ModelResponse[];

  constructor(responses: ModelResponse[]) {
    this.#responses = [...responses];
  }

  async complete(request: CompletionRequest): Promise<ModelResponse> {
    this.requests.push({
      ...request,
      messages: structuredClone(request.messages),
    });
    return (
      this.#responses.shift() ?? {
        text: "完成",
        toolCalls: [],
        usage: { input: 1, output: 1, cached: 0 },
      }
    );
  }
}

function response(text: string): ModelResponse {
  return {
    text,
    toolCalls: [],
    usage: { input: 12, output: 3, cached: 2 },
  };
}

test("AgentSession.forkBranch：分裂分支、切换当前分支、新事件归属新分支", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-fork-cwd-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-fork-state-"),
  );
  const client = new ScriptedClient([
    response("回答一"),
    response("回答二"),
    response("回答三"),
  ]);
  const session = new AgentSession({
    id: "fork-session",
    title: "分支测试",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(client, []),
    stateDir,
  });

  await session.sendInput("写 A 功能");
  await session.sendInput("补 B 功能");

  // 无效 seq 被拒绝
  assert.throws(() => session.forkBranch(99), /seq 无效/);
  assert.throws(() => session.forkBranch(0), /seq 无效/);

  const branchId = session.forkBranch(2, "尝试方案C");
  assert.equal(session.branches().length, 2);
  assert.equal(session.branches()[1]?.parent, "main");
  assert.equal(session.branches()[1]?.forkSeq, 2);
  assert.equal(session.branches()[1]?.label, "尝试方案C");
  assert.equal(session.currentBranchId(), branchId);

  // branch_switch 事件本身归属新分支
  const switchRecord = session.events().at(-1);
  assert.equal(switchRecord?.event.type, "branch_switch");
  assert.equal(switchRecord?.branchId, branchId);

  await session.sendInput("改用方案C");
  const records = session.events();

  // 新分支上所有新事件（branch_switch 之后）带新 branchId
  const switchIndex = records.findIndex(
    (record) => record.event.type === "branch_switch",
  );
  for (const record of records.slice(switchIndex)) {
    assert.equal(record.branchId, branchId);
  }

  // 模型历史重建为分支链视角（fork 点 seq=2 之后 main 上的第二轮不进入）：
  // 链 [main, 新分支] → fork 前 2 条消息 + 本轮新 user（不含本轮响应）
  const lastRequest = client.requests.at(-1);
  assert.deepEqual(
    lastRequest?.messages.map((message) => message.content),
    ["写 A 功能", "回答一", "改用方案C"],
  );

  await session.flush();
});

test("AgentSession.forkBranch：运行中拒绝分支", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-fork-cwd2-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-fork-state2-"),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blockingClient: ModelClient = {
    async complete(): Promise<ModelResponse> {
      await gate;
      return response("完成");
    },
  };
  const session = new AgentSession({
    id: "fork-busy",
    title: "运行中",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(blockingClient, []),
    stateDir,
  });
  const sending = session.sendInput("慢任务");
  // 等第一轮进入运行状态
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.throws(() => session.forkBranch(1), /运行中/);
  release();
  await sending;
});

test("branchesFromEvents：同一分支分裂+回溯只建一个节点", () => {
  const branches = branchesFromEvents([
    event(
      1,
      { type: "branch_switch", branchId: "b1", parent: "main", forkSeq: 1 },
      "b1",
    ),
    event(2, { type: "user", text: "分支任务" }, "b1"),
    // 回溯到 main（复用 branch_switch，不建新节点）
    event(
      3,
      { type: "branch_switch", branchId: "main", parent: "b1", forkSeq: 1 },
      "main",
    ),
    event(4, { type: "user", text: "主线继续" }, "main"),
    // 再切回 b1
    event(
      5,
      { type: "branch_switch", branchId: "b1", parent: "main", forkSeq: 1 },
      "b1",
    ),
  ]);
  assert.equal(branches.length, 2);
  assert.equal(branches[1]?.id, "b1");
});

test("conversationFrom：回溯到 main 后视角为主干全部事件（含回溯点后的新事件）", () => {
  const records = [
    event(1, { type: "user", text: "开场" }),
    event(2, { type: "text_delta", text: "回答" }),
    event(
      3,
      { type: "branch_switch", branchId: "b1", parent: "main", forkSeq: 2 },
      "b1",
    ),
    event(4, { type: "user", text: "分支探索" }, "b1"),
    event(5, { type: "text_delta", text: "分支回答" }, "b1"),
    event(
      6,
      { type: "branch_switch", branchId: "main", parent: "b1", forkSeq: 2 },
      "main",
    ),
    event(7, { type: "user", text: "主线继续" }, "main"),
    event(8, { type: "text_delta", text: "主线回答" }, "main"),
  ];
  const branches = branchesFromEvents(records);
  const messages = conversationFrom(records, branches, "main");
  assert.deepEqual(messages, [
    { role: "user", content: "开场" },
    { role: "assistant", content: "回答", toolCalls: [] },
    { role: "user", content: "主线继续" },
    { role: "assistant", content: "主线回答", toolCalls: [] },
  ]);
  // b1 视角不受回溯影响：只含 fork 前 + b1 分支事件
  const b1Messages = conversationFrom(records, branches, "b1");
  assert.deepEqual(b1Messages, [
    { role: "user", content: "开场" },
    { role: "assistant", content: "回答", toolCalls: [] },
    { role: "user", content: "分支探索" },
    { role: "assistant", content: "分支回答", toolCalls: [] },
  ]);
});

test("AgentSession.switchBranch：回溯切换、模型历史重建、后续事件归属目标分支", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-goto-cwd-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-goto-state-"),
  );
  const client = new ScriptedClient([
    response("回答一"),
    response("回答二"),
    response("回答三"),
    response("回答四"),
  ]);
  const session = new AgentSession({
    id: "goto-session",
    title: "回溯测试",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(client, []),
    stateDir,
  });

  await session.sendInput("主线任务");
  const branchId = session.forkBranch(1, "试验");
  await session.sendInput("分支任务");
  const beforeSwitch = session.events().length;

  // 无效分支被拒绝
  assert.throws(() => session.switchBranch("no-such"), /不存在/);
  // 切回 main：不建新节点
  session.switchBranch("main");
  assert.equal(session.branches().length, 2);
  assert.equal(session.currentBranchId(), "main");
  // 回溯事件归属 main
  const switchRecord = session.events().at(-1);
  assert.equal(switchRecord?.event.type, "branch_switch");
  assert.equal(switchRecord?.branchId, "main");

  await session.sendInput("主线继续");
  const mainUser = [...session.events()]
    .reverse()
    .find((record) => record.event.type === "user");
  assert.equal(mainUser?.branchId, "main");

  // 再切回分支 b1
  session.switchBranch(branchId);
  await session.sendInput("分支继续");
  const branchUser = [...session.events()]
    .reverse()
    .find((record) => record.event.type === "user");
  assert.equal(branchUser?.branchId, branchId);
  // 分支树仍只有两个节点
  assert.equal(session.branches().length, 2);

  // 模型历史：切回 b1 后 = fork 点前 + b1 分支事件（回溯/主线事件不进入）
  const lastRequest = client.requests.at(-1);
  assert.deepEqual(
    lastRequest?.messages.map((message) => message.content),
    ["主线任务", "分支任务", "回答二", "分支继续"],
  );

  // 事件总数：beforeSwitch 之后 = 2 次回溯 switch + 2 轮 × 4 事件 = 10
  assert.equal(session.events().length, beforeSwitch + 10);
  await session.flush();
});

test("恢复后分支状态与当前分支保持：continue 走新分支", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-fork-cwd3-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-fork-state3-"),
  );
  const client = new ScriptedClient([
    response("回答一"),
    response("回答二"),
    response("回答三"),
  ]);
  const session = new AgentSession({
    id: "fork-restore",
    title: "分支恢复",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(client, []),
    stateDir,
  });
  await session.sendInput("任务一");
  const branchId = session.forkBranch(1, "试验分支");
  await session.sendInput("分支上的任务");
  await session.flush();

  // 从磁盘重建会话
  const { AgentSessionManager } = await import("./session-manager.js");
  const { ConfigService } = await import("../config/service.js");
  let restoredHistory: ConversationMessage[] = [];
  const manager = new AgentSessionManager({
    cwd,
    stateDir,
    homeDir: cwd,
    configService: new ConfigService({ cwd, homeDir: cwd }),
    modelFactory: (messages) => {
      restoredHistory = structuredClone(messages);
      return new ConversationAgentModel(
        new ScriptedClient([response("继续")]),
        messages,
      );
    },
  });
  await manager.restore();
  const restored = manager.get("fork-restore");
  assert.ok(restored);

  // 当前分支与分支树恢复正确
  assert.equal(restored.currentBranchId(), branchId);
  assert.equal(restored.branches().length, 2);
  assert.equal(restored.branches()[1]?.id, branchId);

  // 模型历史是分支链视角：fork 点 seq=1，main 只贡献到 seq1（"回答一"在
  // fork 点之后，属于被放弃的路径，不进入新分支）
  assert.deepEqual(
    restoredHistory.map((message) => message.content),
    ["任务一", "分支上的任务", "回答二"],
  );

  // 继续对话仍写新分支
  await restored.sendInput("继续分支任务");
  const lastUser = [...restored.events()]
    .reverse()
    .find((record) => record.event.type === "user");
  assert.equal(lastUser?.branchId, branchId);
  await manager.flush();

  // 磁盘记录中 branch_switch 归属新分支
  const { SessionStore } = await import("./events.js");
  const store = new SessionStore(
    path.join(stateDir, "projects", Buffer.from(cwd).toString("base64url"), "sessions", "fork-restore.jsonl"),
    "fork-restore",
  );
  const records = await store.readAll();
  const switchRecord = records.find(
    (record) => record.event.type === "branch_switch",
  );
  assert.equal(switchRecord?.branchId, branchId);
  const branchRecords = records.filter(
    (record) => record.branchId === branchId,
  );
  // branch_switch + 分支上的 user/text_delta/cost_update/done ×2 轮
  assert.equal(branchRecords.length, 9);
});
