import type { ConversationAgentModel } from "./agent-model.js";
import type { PermissionEngine } from "./permissions.js";
import type { BranchCoordinator } from "./session-branch.js";
import type { AgentEvent, TodoItem } from "./types.js";
import type { SessionStatus } from "../shared/types.js";

/** 事件状态应用的外部依赖（权限档/分支树/模型 todo 同步） */
export interface SessionStateDeps {
  permissions: PermissionEngine;
  branchOps: BranchCoordinator;
  model: ConversationAgentModel;
}

/**
 * 会话状态机与统计聚合：事件流 → 会话状态/成本/todo 的唯一落点。
 * - 状态：user/ask_permission/done/need_user/error/interrupted 事件驱动切换
 * - 成本：cost_update 累计 token/费用，按 providerId/model 拆分维度桶
 * - todo：todo_update 事件同步快照并回灌模型上下文
 * 自 session.ts 拆分（原 #applyEventState + 统计字段），行为逐行等价。
 */
export class SessionStateMachine {
  #status: SessionStatus = "idle";
  #totalInputTokens = 0;
  #totalOutputTokens = 0;
  #totalCachedTokens = 0;
  #totalCostCny = 0;
  /** 累计缓存浪费（仅计异常失效；压缩属合法重置不计入，参照 Pi cache-stats） */
  #totalMissedTokens = 0;
  #totalMissedCostCny = 0;
  /** 按模型/供应商拆分的成本（cost_update 带来源时累计；key = providerId/model） */
  readonly #costByModel = new Map<
    string,
    { providerId: string; model: string; costCny: number; tokens: number }
  >();
  #todos: TodoItem[] = [];

  get status(): SessionStatus {
    return this.#status;
  }

  setStatus(status: SessionStatus): void {
    this.#status = status;
  }

  tokens(): number {
    return this.#totalInputTokens + this.#totalOutputTokens;
  }

  inputTokens(): number {
    return this.#totalInputTokens;
  }

  outputTokens(): number {
    return this.#totalOutputTokens;
  }

  cachedTokens(): number {
    return this.#totalCachedTokens;
  }

  costCny(): number {
    return this.#totalCostCny;
  }

  missedTokens(): number {
    return this.#totalMissedTokens;
  }

  missedCostCny(): number {
    return this.#totalMissedCostCny;
  }

  /** todo 快照（调用方需 clone 后使用） */
  todos(): TodoItem[] {
    return this.#todos;
  }

  /** 按模型/供应商拆分的成本（费用降序副本） */
  costByModel(): Array<{
    providerId: string;
    model: string;
    costCny: number;
    tokens: number;
  }> {
    return [...this.#costByModel.values()]
      .map((bucket) => ({ ...bucket }))
      .sort((a, b) => b.costCny - a.costCny);
  }

  /** 应用一条会话事件到状态机（事件流恢复与实时记录共用同一路径） */
  apply(event: AgentEvent, deps: SessionStateDeps): void {
    if (event.type === "user") this.#status = "running";
    if (event.type === "permission_mode_changed") {
      deps.permissions.setMode(event.mode);
    }
    if (event.type === "ask_permission") this.#status = "waiting_permission";
    if (event.type === "todo_update") {
      this.#todos = structuredClone(event.todos);
      deps.model.setTodos(this.#todos);
    }
    if (event.type === "cost_update") {
      this.#totalInputTokens += event.input;
      this.#totalOutputTokens += event.output;
      this.#totalCachedTokens += event.cached ?? 0;
      this.#totalCostCny += event.costCny ?? 0;
      if (event.missedTokens && event.missedReason !== "compaction") {
        this.#totalMissedTokens += event.missedTokens;
        this.#totalMissedCostCny += event.missedCostCny ?? 0;
      }
      // 按模型/供应商拆分（缺失来源的轮次不进入维度统计）
      if (event.providerId || event.model) {
        const providerId = event.providerId ?? "unknown";
        const model = event.model ?? "unknown";
        const key = `${providerId}/${model}`;
        const bucket = this.#costByModel.get(key) ?? {
          providerId,
          model,
          costCny: 0,
          tokens: 0,
        };
        bucket.costCny += event.costCny ?? 0;
        bucket.tokens += event.input + event.output;
        this.#costByModel.set(key, bucket);
      }
    }
    if (event.type === "done") this.#status = "done";
    if (event.type === "need_user") this.#status = "done";
    if (event.type === "error") this.#status = "error";
    if (event.type === "interrupted") this.#status = "interrupted";
    if (event.type === "branch_switch") {
      deps.branchOps.noteSwitch(event.branchId);
    }
  }
}
