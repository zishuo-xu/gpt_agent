import type { ConversationMessage } from "../model/types.js";
import type {
  AgentEvent,
  SessionBranch,
  ToolCall,
} from "./types.js";

export const ROOT_BRANCH = "main";

/** 内存事件与磁盘记录共有的结构（RecordedEvent 含额外 sessionId） */
export interface BranchEventLike {
  seq: number;
  ts: string;
  event: AgentEvent;
  branchId?: string;
}

/** 从事件流重建分支树（branch_switch 事件即真相，不依赖额外文件） */
export function branchesFromEvents(
  records: readonly BranchEventLike[],
): SessionBranch[] {
  const branches: SessionBranch[] = [
    {
      id: ROOT_BRANCH,
      parent: null,
      forkSeq: null,
      createdAt: records[0]?.ts ?? new Date().toISOString(),
    },
  ];
  for (const record of records) {
    const event = record.event;
    if (event.type !== "branch_switch") continue;
    // 同一分支可能被多次回溯切换（branch_switch 复用）；仅首次（分裂）建节点
    if (branches.some((branch) => branch.id === event.branchId)) {
      continue;
    }
    branches.push({
      id: event.branchId,
      parent: event.parent,
      forkSeq: event.forkSeq,
      ...(event.label ? { label: event.label } : {}),
      createdAt: record.ts,
    });
  }
  return branches;
}

/** 当前分支：最后一个 branch_switch 指向的分支；无分支会话为 main */
export function currentBranchIdFrom(
  records: readonly BranchEventLike[],
): string {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const event = records[index]?.event;
    if (event?.type === "branch_switch") return event.branchId;
  }
  return ROOT_BRANCH;
}

/** 沿 parent 链收集分支祖先（含自身）：[main, …, branchId] */
export function branchChain(
  branches: readonly SessionBranch[],
  branchId: string,
): SessionBranch[] {
  const byId = new Map(branches.map((branch) => [branch.id, branch]));
  const chain: SessionBranch[] = [];
  let current = byId.get(branchId);
  while (current) {
    chain.unshift(current);
    current = current.parent ? byId.get(current.parent) : undefined;
  }
  return chain.length > 0
    ? chain
    : [
        {
          id: ROOT_BRANCH,
          parent: null,
          forkSeq: null,
          createdAt: "",
        },
      ];
}

/** 过滤出属于目标分支链的事件：
    每个祖先分支只保留到其沿路径下一分支 fork 点之前的事件
    （fork 点之后、fork 之前发生在祖先上的事件属于被放弃的路径，不进入新分支视角） */
export function filterRecordsForBranch(
  records: readonly BranchEventLike[],
  branches: readonly SessionBranch[],
  branchId: string,
): BranchEventLike[] {
  const chain = branchChain(branches, branchId);
  // 各链上分支的截止 seq：下一分支的 forkSeq；目标分支自身不设限
  const cutoff = new Map<string, number>();
  for (const [index, branch] of chain.entries()) {
    const next = chain[index + 1];
    cutoff.set(
      branch.id,
      next?.forkSeq ?? Number.POSITIVE_INFINITY,
    );
  }
  return records.filter((record) => {
    const recordBranch = record.branchId ?? ROOT_BRANCH;
    const limit = cutoff.get(recordBranch);
    if (limit === undefined) return false;
    return record.seq <= limit;
  });
}

/** 从事件流重建模型消息历史；branchId 缺省时使用当前分支 */
export function conversationFrom(
  records: readonly BranchEventLike[],
  branches?: readonly SessionBranch[],
  branchId?: string,
): ConversationMessage[] {
  const target = branchId ?? currentBranchIdFrom(records);
  const filtered = branches
    ? filterRecordsForBranch(records, branches, target)
    : records;
  return conversationFromRaw(filtered);
}

/** 事件列表 → 模型消息（供分支摘要等场景直接复用；含压缩摘要与分支摘要处理） */
export function conversationFromRaw(
  records: readonly BranchEventLike[],
): ConversationMessage[] {
  const lastCompaction = [...records]
    .reverse()
    .find((record) => record.event.type === "context_compacted");
  if (lastCompaction?.event.type === "context_compacted") {
    const compactEvent = lastCompaction.event;
    return [
      {
        role: "user",
        content: `[会话压缩摘要]\n${compactEvent.summary}`,
      },
      ...conversationFromRaw(
        records.filter(
          (record) =>
            record.seq >= compactEvent.keepFromSeq &&
            record.event.type !== "context_compacted" &&
            record.event.type !== "branch_switch",
        ),
      ),
    ];
  }
  const messages: ConversationMessage[] = [];
  const calls = new Map<string, ToolCall>();
  for (const { event } of records) {
    if (event.type === "branch_switch") continue;
    if (event.type === "user") {
      messages.push({
        role: "user",
        content: event.modelText ?? event.text,
      });
    } else if (event.type === "text_delta") {
      messages.push({
        role: "assistant",
        content: event.text,
        toolCalls: [],
      });
    } else if (event.type === "tool_call") {
      calls.set(event.call.id, event.call);
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [event.call],
      });
    } else if (event.type === "tool_result") {
      const call = calls.get(event.callId);
      if (!call) continue;
      messages.push({
        role: "tool",
        toolCallId: event.callId,
        toolName: call.tool,
        target: call.target,
        content:
          event.output === undefined
            ? event.summary
            : `${event.summary}\n${stringify(event.output)}`,
        isError: event.isError ?? Boolean(event.aborted),
      });
    } else if (event.type === "permission_denied") {
      messages.push({
        role: "tool",
        toolCallId: event.call.id,
        toolName: event.call.tool,
        target: event.call.target,
        content: `Permission denied: ${event.reason}`,
        isError: true,
      });
    } else if (event.type === "branch_summarized") {
      // 分支摘要注入为新分支视角的 user 消息（切分支后保留被放弃路径的上下文）
      messages.push({
        role: "user",
        content:
          `[分支摘要]（来自分支 ${event.fromBranchId}，fork@#${event.forkSeq}）\n` +
          event.summary,
      });
    }
  }
  return messages;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
