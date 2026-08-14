import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationMessage } from "./types.js";
import { transformMessages } from "./transform-messages.js";

function assistant(
  content: string,
  toolCalls: ConversationMessage & { role: "assistant" } extends never
    ? never
    : Array<{ id: string; tool: string; target?: string; args: Record<string, unknown> }>,
  thinking?: string,
): ConversationMessage {
  return {
    role: "assistant" as const,
    content,
    toolCalls: toolCalls.map((call) => ({ ...call, target: call.target ?? "" })),
    ...(thinking ? { thinking } : {}),
  };
}

test("transformMessages：不合规 toolCallId 重写为 Anthropic 合规格式且映射一致", () => {
  const messages: ConversationMessage[] = [
    assistant("", [
      { id: "call_abc.def!xyz", tool: "Read", target: "a.ts", args: { filePath: "a.ts" } },
      { id: "ok_id_123", tool: "Bash", target: "ls", args: { command: "ls" } },
    ]),
    {
      role: "tool",
      toolCallId: "call_abc.def!xyz",
      toolName: "Read",
      target: "a.ts",
      content: "内容",
    
      isError: false,
    },
    {
      role: "tool",
      toolCallId: "ok_id_123",
      toolName: "Bash",
      target: "ls",
      content: "内容2",
    
      isError: false,
    },
  ];
  const transformed = transformMessages(messages);
  const rewrittenAssistant = transformed[0] as Extract<ConversationMessage, { role: "assistant" }>;
  const rewritten = rewrittenAssistant.toolCalls.find((call) => call.target === "a.ts")!;
  assert.match(rewritten.id, /^[a-zA-Z0-9_-]{1,64}$/, "重写后必须合规");
  assert.notEqual(rewritten.id, "call_abc.def!xyz", "不合规 id 必须被重写");
  const okCall = rewrittenAssistant.toolCalls.find((call) => call.target === "ls")!;
  assert.equal(okCall.id, "ok_id_123", "已合规 id 保持不变");
  const tool = transformed.find(
    (message) => message.role === "tool" && message.target === "a.ts",
  ) as Extract<ConversationMessage, { role: "tool" }>;
  assert.equal(tool.toolCallId, rewritten.id, "tool 消息的 toolCallId 同步重写");
  // 原消息不被修改（不可变）
  const original = messages[0] as Extract<ConversationMessage, { role: "assistant" }>;
  assert.equal(original.toolCalls[0]!.id, "call_abc.def!xyz");
});

test("transformMessages：空 content 的 tool 消息补占位", () => {
  const messages: ConversationMessage[] = [
    { role: "tool" as const, toolCallId: "t1", toolName: "Bash", target: "ls", content: "", isError: false },
    { role: "tool" as const, toolCallId: "t2", toolName: "Read", target: "a.ts", content: "正常内容", isError: false },
  ];
  const transformed = transformMessages(messages);
  assert.equal(
    (transformed[0] as Extract<ConversationMessage, { role: "tool" }>).content,
    "No result provided",
  );
  assert.equal(
    (transformed[1] as Extract<ConversationMessage, { role: "tool" }>).content,
    "正常内容",
    "非空内容不受影响",
  );
});

test("transformMessages：相邻 assistant 消息合并（半截回合聚合）", () => {
  const messages: ConversationMessage[] = [
    { role: "user", content: "需求" },
    // 流式中断/恢复产生的半截回合：多条相邻 assistant
    { role: "assistant", content: "先看", toolCalls: [] },
    { role: "assistant", content: "代码结构", toolCalls: [] },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", tool: "Read", target: "a.ts", args: { filePath: "a.ts" } }],
    },
    { role: "tool" as const, toolCallId: "c1", toolName: "Read", target: "a.ts", content: "内容", isError: false },
  ];
  const transformed = transformMessages(messages);
  const assistants = transformed.filter((m) => m.role === "assistant");
  assert.equal(assistants.length, 1, "相邻 assistant 应合并为一条");
  const merged = assistants[0] as Extract<ConversationMessage, { role: "assistant" }>;
  assert.equal(merged.content, "先看代码结构");
  assert.equal(merged.toolCalls.length, 1);
});

test("transformMessages：孤儿 toolCall 补合成 tool 消息（未配对不发送缺陪）", () => {
  const messages: ConversationMessage[] = [
    { role: "user", content: "需求" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c1", tool: "Read", target: "a.ts", args: { filePath: "a.ts" } },
        { id: "c2", tool: "Bash", target: "ls", args: { command: "ls" } },
      ],
    },
    // c2 有配对，c1 是孤儿（中断批次留在内存）
    { role: "tool" as const, toolCallId: "c2", toolName: "Bash", target: "ls", content: "ok", isError: false },
  ];
  const transformed = transformMessages(messages);
  const tools = transformed.filter((m) => m.role === "tool") as Array<
    Extract<ConversationMessage, { role: "tool" }>
  >;
  assert.equal(tools.length, 2, "孤儿 c1 应补合成 tool 消息");
  const orphan = tools.find((t) => t.toolCallId === "c1")!;
  assert.equal(orphan.content, "No result provided");
  assert.equal(orphan.isError, true);
  assert.equal(orphan.toolName, "Read");
});

test("transformMessages：空 assistant 消息（无文本无工具）被丢弃", () => {
  const messages: ConversationMessage[] = [
    { role: "user", content: "需求" },
    { role: "assistant", content: "", toolCalls: [] }, // 空：Anthropic content:[] 400
    { role: "assistant", content: "正常", toolCalls: [] },
  ];
  const transformed = transformMessages(messages);
  assert.deepEqual(
    transformed.map((m) => (m.role === "assistant" ? m.content : m.role)),
    ["user", "正常"],
    "空 assistant 应被丢弃",
  );
});

test("transformMessages：thinking 字段在合并时保留（取后者的）", () => {
  const messages: ConversationMessage[] = [
    { role: "assistant", content: "前半", toolCalls: [], thinking: "思考过程" },
    { role: "assistant", content: "后半", toolCalls: [] },
  ];
  const transformed = transformMessages(messages);
  const merged = transformed[0] as Extract<ConversationMessage, { role: "assistant" }>;
  assert.equal(merged.content, "前半后半");
  assert.equal(merged.thinking, "思考过程");
});
