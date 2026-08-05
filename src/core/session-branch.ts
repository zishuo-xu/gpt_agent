import { randomUUID } from "node:crypto";
import type { ModelClient } from "../model/types.js";
import { usageCostCny } from "../utils/cost.js";
import {
  type ConversationAgentModel,
  summarizeConversation,
} from "./agent-model.js";
import {
  branchesFromEvents,
  conversationFrom,
  conversationFromRaw,
  currentBranchIdFrom,
} from "./branch.js";
import type { AgentEventBus } from "./events.js";
import type {
  ModelPricing,
  RecordedEvent,
  SessionBranch,
} from "./types.js";

/** 分支摘要触发阈值：被放弃路径估算 token 低于此值不值得一次 cheap 调用 */
const BRANCH_SUMMARY_MIN_TOKENS = 5_000;

/**
 * 分支树协调器（AgentSession 委托）：
 * - 分支状态（branches/currentBranchId）唯一持有者，branch_switch 事件即真相；
 * - fork/switch 重建模型消息历史（分支链视角）并排队被放弃路径的摘要；
 * - 摘要用 cheap 客户端异步串行执行，失败不阻断分支切换。
 */
export class BranchCoordinator {
  readonly #bus: AgentEventBus;
  readonly #model: ConversationAgentModel;
  readonly #branchSummaryClient: ModelClient | undefined;
  readonly #pricing:
    | Partial<Record<"main" | "cheap" | "explore", ModelPricing>>
    | undefined;
  readonly #getTotalTokens: () => number;
  readonly #getTotalCostCny: () => number;
  #branches: SessionBranch[];
  #currentBranchId: string;
  /** 分支摘要异步链：fork/switch 触发的摘要串行执行，flush 时等待落定 */
  #branchSummaryTail: Promise<void> = Promise.resolve();

  constructor(options: {
    bus: AgentEventBus;
    model: ConversationAgentModel;
    branchSummaryClient?: ModelClient;
    pricing?: Partial<
      Record<"main" | "cheap" | "explore", ModelPricing>
    >;
    getTotalTokens: () => number;
    getTotalCostCny: () => number;
    restoredEvents?: readonly RecordedEvent[];
  }) {
    this.#bus = options.bus;
    this.#model = options.model;
    this.#branchSummaryClient = options.branchSummaryClient;
    this.#pricing = options.pricing;
    this.#getTotalTokens = options.getTotalTokens;
    this.#getTotalCostCny = options.getTotalCostCny;
    this.#branches = branchesFromEvents(options.restoredEvents ?? []);
    this.#currentBranchId = currentBranchIdFrom(
      options.restoredEvents ?? [],
    );
  }

  /** 分支树（根分支 main 恒存在） */
  branches(): SessionBranch[] {
    return structuredClone(this.#branches);
  }

  /** 当前分支 id */
  currentBranchId(): string {
    return this.#currentBranchId;
  }

  /** branch_switch 事件落盘后同步当前分支（#applyEventState 调用） */
  noteSwitch(branchId: string): void {
    this.#currentBranchId = branchId;
  }

  /** 从指定 seq 处分裂新分支并切换；后续消息走新分支 */
  fork(
    events: readonly RecordedEvent[],
    forkSeq: number,
    label?: string,
  ): string {
    const maxSeq = events.at(-1)?.seq ?? 0;
    if (!Number.isInteger(forkSeq) || forkSeq < 1 || forkSeq > maxSeq) {
      throw new Error(`分支点 seq 无效：需要 1-${maxSeq} 之间的整数`);
    }
    const branchId = randomUUID().slice(0, 6);
    this.#branches.push({
      id: branchId,
      parent: this.#currentBranchId,
      forkSeq,
      ...(label?.trim() ? { label: label.trim() } : {}),
      createdAt: new Date().toISOString(),
    });
    const fromBranchId = this.#currentBranchId;
    // branch_switch 事件落在新分支上（#applyEventState 同步切换 currentBranchId）
    this.#bus.emit({
      type: "branch_switch",
      branchId,
      parent: fromBranchId,
      forkSeq,
      ...(label?.trim() ? { label: label.trim() } : {}),
    });
    this.#model.resetConversation(
      conversationFrom(events, this.#branches, branchId),
    );
    // 分支摘要：被放弃的旧分支路径（fork 点之后）压缩注入新分支（参照 Pi branch-summarization）
    this.#queueBranchSummary(forkSeq, fromBranchId, events);
    return branchId;
  }

  /** 回溯切换到已存在的分支（不建新节点）；后续消息写入目标分支 */
  switch(events: readonly RecordedEvent[], branchId: string): void {
    const target = this.#branches.find(
      (branch) => branch.id === branchId,
    );
    if (!target) {
      throw new Error(`分支 #${branchId} 不存在（/tree 查看）`);
    }
    if (target.id === this.#currentBranchId) return;
    const fromBranchId = this.#currentBranchId;
    // 复用 branch_switch 事件：目标分支已存在时 branchesFromEvents 只切换不建节点
    this.#bus.emit({
      type: "branch_switch",
      branchId: target.id,
      parent: fromBranchId,
      forkSeq: target.forkSeq ?? 0,
      ...(target.label ? { label: target.label } : {}),
    });
    this.#model.resetConversation(
      conversationFrom(events, this.#branches, branchId),
    );
    // 离开当前分支前摘要被放弃的路径（当前分支上目标 fork 点之后的事件）
    this.#queueBranchSummary(target.forkSeq ?? 0, fromBranchId, events);
  }

  /** 等待分支摘要链落定（flush 时调用） */
  async flush(): Promise<void> {
    await this.#branchSummaryTail;
  }

  #queueBranchSummary(
    forkSeq: number,
    fromBranchId: string,
    events: readonly RecordedEvent[],
  ): void {
    this.#branchSummaryTail = this.#branchSummaryTail
      .then(() => this.#summarizeAbandonedPath(forkSeq, fromBranchId, events))
      .catch(() => undefined);
  }

  async #summarizeAbandonedPath(
    forkSeq: number,
    fromBranchId: string,
    events: readonly RecordedEvent[],
  ): Promise<void> {
    const client = this.#branchSummaryClient;
    if (!client) return;
    const abandoned = events.filter(
      (record) =>
        record.branchId === fromBranchId && record.seq > forkSeq,
    );
    const messages = conversationFromRaw(abandoned);
    if (messages.length === 0) return;
    const estimated = Math.ceil(JSON.stringify(messages).length / 4);
    if (estimated < BRANCH_SUMMARY_MIN_TOKENS) return;
    let result: {
      summary: string;
      usage: { input: number; output: number; cached: number };
    };
    try {
      result = await summarizeConversation(
        client,
        messages,
        new AbortController().signal,
      );
    } catch {
      // 摘要失败不阻断分支切换（上下文延续是增强，不是硬依赖）
      return;
    }
    this.#model.addUserMessage(
      `[分支摘要]（来自分支 ${fromBranchId}，fork@#${forkSeq}）\n` +
        result.summary,
    );
    this.#bus.emit({
      type: "branch_summarized",
      branchId: this.#currentBranchId,
      fromBranchId,
      forkSeq,
      summary: result.summary,
    });
    const costCny = usageCostCny(result.usage, this.#pricing?.cheap);
    const actualCostCny = costCny;
    this.#bus.emit({
      type: "cost_update",
      input: result.usage.input,
      output: result.usage.output,
      cached: result.usage.cached,
      totalTokens:
        this.#getTotalTokens() +
        result.usage.input +
        result.usage.output,
      ...(actualCostCny === undefined
        ? {}
        : {
            costCny: actualCostCny,
            totalCostCny: this.#getTotalCostCny() + actualCostCny,
          }),
    });
  }
}
