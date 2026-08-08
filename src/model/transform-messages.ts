import type { ConversationMessage } from "./types.js";

/**
 * 消息转换层（参照 Pi 的 transform-messages.ts，每次请求前必跑）：
 * - toolCallId 归一化：超长/特殊字符 id 确定性重写为 Anthropic 合规格式
 *   （OpenAI 兼容端点的 450+ 字符 id 切到 Anthropic 时 400 的坑）；
 * - 空 tool content 兜底（"No result provided"）；
 * - 相邻 assistant 消息合并：流式中断/恢复产生的半截回合聚合为完整回合
 *   （content 拼接、toolCalls 拼接）；
 * - 孤儿 toolCall 补合成 tool 消息：中断批次留在内存的未配对调用补
 *   "No result provided" + isError，避免切换供应商后缺配套 tool 消息；
 * - 空 assistant 消息丢弃（content 与 toolCalls 均空，Anthropic 发
 *   content: [] 会 400）。
 */

/** 确定性哈希：同一输入始终映射同一合规 id（跨轮重放时映射稳定） */
function stableId(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36).padStart(8, "0");
}

export function transformMessages(
  messages: readonly ConversationMessage[],
): ConversationMessage[] {
  // 1. toolCallId 归一化（assistant.toolCalls → tool 消息同步改写）
  const idMap = new Map<string, string>();
  const normalized = messages.map((message) => {
    if (message.role === "assistant" && message.toolCalls.length > 0) {
      const toolCalls = message.toolCalls.map((call) => {
        if (/^[a-zA-Z0-9_-]{1,64}$/.test(call.id)) return call;
        const rewritten = `toolu_${stableId(call.id)}`;
        idMap.set(call.id, rewritten);
        return { ...call, id: rewritten };
      });
      return { ...message, toolCalls };
    }
    if (message.role === "tool") {
      const toolCallId = idMap.get(message.toolCallId) ?? message.toolCallId;
      const content =
        message.content.trim().length > 0
          ? message.content
          : "No result provided";
      if (toolCallId === message.toolCallId && content === message.content) {
        return message;
      }
      return { ...message, toolCallId, content };
    }
    return message;
  });

  // 2. 相邻 assistant 合并 + 空 assistant 丢弃 + 孤儿 toolCall 补结果
  const merged: ConversationMessage[] = [];
  for (const message of normalized) {
    const last = merged.at(-1);
    if (message.role === "assistant" && last?.role === "assistant") {
      // 相邻 assistant：content 拼接（thinking 取后者的，前面的半截通常无 thinking）
      merged[merged.length - 1] = {
        ...last,
        content: [last.content, message.content].filter(Boolean).join(""),
        toolCalls: [...last.toolCalls, ...message.toolCalls],
        ...(message.thinking ? { thinking: message.thinking } : {}),
      };
      continue;
    }
    if (message.role === "assistant") {
      // 空 assistant（无文本无工具）丢弃：Anthropic content:[] 会 400
      if (!message.content && message.toolCalls.length === 0) continue;
      merged.push(message);
      continue;
    }
    merged.push(message);
  }

  // 3. 孤儿 toolCall 补合成 tool 消息：归一化后按 id 配对，缺配套 tool 消息的补失败结果
  const paired = new Set<string>();
  for (const message of merged) {
    if (message.role === "tool") paired.add(message.toolCallId);
  }
  const completed: ConversationMessage[] = [];
  for (const message of merged) {
    completed.push(message);
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls) {
      if (paired.has(call.id)) continue;
      paired.add(call.id);
      completed.push({
        role: "tool",
        toolCallId: call.id,
        toolName: call.tool,
        target: call.target,
        content: "No result provided",
        isError: true,
      });
    }
  }
  return completed;
}
