import type { ToolName } from "../shared/tool-names.js";

export type PermissionMode = "strict" | "normal" | "trust";
export type PermissionEffect = "allow" | "ask" | "deny";
export type { ToolName };

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

/** 任务执行账本单元状态（系统自动记账 + 模型显式确认双通道合并） */
export type LedgerStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "verified"
  | "blocked";

/** 任务执行账本单元：文件或逻辑子任务的显式进度记录 */
export interface LedgerUnit {
  /** 稳定标识：规范化相对路径（文件）或任务项 slug */
  id: string;
  kind: "file" | "task";
  /** 人类可读（文件相对路径） */
  label: string;
  status: LedgerStatus;
  /** 完成说明 / 卡点原因 */
  note?: string;
  /** 验证证据（命令 + 关键输出摘要） */
  evidence?: string;
  updatedAt: string;
}

export interface PermissionRule {
  effect: PermissionEffect;
  pattern: string;
}

export interface ModelPricing {
  inputPerMillionCny: number;
  outputPerMillionCny: number;
  cachedInputPerMillionCny: number;
}

export interface ToolCall {
  id: string;
  /** 工具名：内置名见 TOOL_NAMES；插件名见 PluginToolRegistry（.myagent/tools/）。
      开放集合是插件通道的前提——client 运行时守卫按两者联合校验 */
  tool: string;
  target: string;
  args: unknown;
  purpose?: string;
}

/** 文件操作跟踪（P0-3）：压缩时携带，压缩后模型仍知道动过哪些文件。
    路径为相对 cwd 的规范化形式（Read → read；Edit/MultiEdit/Write → modified）。 */
export interface FileOps {
  read: string[];
  modified: string[];
}

export type AgentEvent =
  | {
      type: "user";
      text: string;
      modelText?: string;
      queueId?: string;
    }
  | {
      type: "user_queued";
      text: string;
      queueId: string;
      /** Steer 插队消息：打断当前工具批次后优先处理（参照 Pi 的 steer 两档排队） */
      steer?: boolean;
    }
  | { type: "permission_mode_changed"; mode: PermissionMode }
  | {
      type: "context_compacted";
      summary: string;
      ratio: number;
      keepFromSeq: number;
      /** 压缩时的文件操作跟踪（P0-3）：前端可展示，旧事件兼容 */
      fileOps?: FileOps;
    }
  | {
      type: "task_start";
      taskId: string;
      description: string;
    }
  | {
      type: "task_event";
      taskId: string;
      eventType: string;
      summary?: string;
    }
  | {
      type: "task_end";
      taskId: string;
      status: "completed" | "failed" | "interrupted";
      toolCalls: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      summary: string;
      /** 结束原因：子代理超时强制结束时标记 */
      reason?: "timeout";
    }
  | {
      type: "run_started";
      taskId: string;
      description: string;
      permissionMode: PermissionMode;
      deadline?: string;
      budgetCny?: number;
      hardRules: PermissionRule[];
      /** 完整任务选项（崩溃恢复续跑用；旧事件可能缺失） */
      taskOptions?: {
        description: string;
        goal?: string;
        bounds?: string;
        until?: string;
        deadline?: string;
        budgetCny?: number;
        permission?: PermissionMode;
        hardRules: PermissionRule[];
        semanticBounds: string[];
      };
    }
  | {
      type: "wrapup_warning";
      taskId: string;
      level: "narrow" | "wrapup" | "final";
      reason: "deadline" | "budget";
      message: string;
    }
  | {
      type: "run_finished";
      taskId: string;
      status: "completed" | "interrupted" | "failed";
      reason?: "done" | "deadline" | "budget" | "error" | "interrupted";
    }
  | {
      type: "model_fallback";
      role: "main" | "cheap" | "explore";
      from: string;
      to: string;
      reason: string;
    }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "todo_update"; todos: TodoItem[] }
  | {
      type: "ledger_update";
      taskId: string;
      /** 增量变更的单元（恢复时按 taskId 投影重建账本） */
      unit: LedgerUnit;
    }
  | { type: "tool_call"; call: ToolCall }
  | {
      type: "tool_execution_update";
      callId: string;
      /** 实时增量输出（仅 UI 展示，不进模型上下文；对齐 Pi 的流式 partial） */
      partial: string;
    }
  | {
      type: "tool_result";
      callId: string;
      summary: string;
      output?: unknown;
      /** 仅 UI 展示的结构化详情（不进模型上下文，参照 Pi 的工具结果拆分） */
      details?: unknown;
      aborted?: boolean;
      isError?: boolean;
    }
  | {
      type: "ask_permission";
      call: ToolCall;
      risk: string;
      detail?: string;
    }
  | { type: "permission_denied"; call: ToolCall; reason: string }
  | {
      type: "cost_update";
      input: number;
      output: number;
      cached: number;
      totalTokens: number;
      costCny?: number;
      totalCostCny?: number;
      /** 成本来源（按模型/供应商拆维度统计；子代理/压缩轮次可能缺失） */
      providerId?: string;
      model?: string;
      /** 本应命中缓存却未命中的 token 数（参照 Pi 的 cache-stats：missedCost 度量） */
      missedTokens?: number;
      /** 缓存失效原因：压缩（合法）/ 模型切换（异常）/ 空闲超时（TTL） */
      missedReason?: "compaction" | "model_switch" | "idle";
      /** 因 miss 多付的费用（元）；压缩属合法重置不计入，仅在异常失效时给出 */
      missedCostCny?: number;
    }
  | { type: "done" }
  | { type: "need_user"; question: string }
  | { type: "error"; message: string }
  | { type: "notify"; level: "info" | "warn" | "error"; message: string }
  | { type: "interrupted"; scope: "model" | "tool" | "loop" }
  | {
      type: "branch_switch";
      branchId: string;
      parent: string | null;
      /** 分裂点：父分支中最后一个被新分支继承的 seq */
      forkSeq: number;
      label?: string;
    }
  | {
      type: "branch_summarized";
      /** 摘要注入的目标分支（切换后的新分支） */
      branchId: string;
      /** 被放弃的旧分支 */
      fromBranchId: string;
      /** 被摘要的事件范围起点（fork 点之后） */
      forkSeq: number;
      summary: string;
    }
  | {
      /** 会话标题（写入事件流，恢复时优先于 index.json 缓存） */
      type: "session_info";
      name: string;
    }
  | {
      /** 书签：标记某条事件 seq，长会话导航用（参照 Pi 的 label entry） */
      type: "label";
      seq: number;
      name: string;
    };

export interface SessionBranch {
  id: string;
  parent: string | null;
  /** 分裂点：根分支为 null */
  forkSeq: number | null;
  label?: string;
  createdAt: string;
}

export interface RecordedEvent {
  seq: number;
  ts: string;
  /** 落盘时由 SessionStore 补齐；会话内事件记录无此字段 */
  sessionId?: string;
  /** 事件所属分支；缺省 "main"（旧会话文件兼容） */
  branchId?: string;
  event: AgentEvent;
}

export interface ToolExecutionResult {
  summary: string;
  output?: unknown;
  /** 仅 UI 展示的结构化详情（不进模型上下文；旧事件回放无此字段也兼容） */
  details?: unknown;
  traceOutput?: unknown;
  aborted?: boolean;
  todoSnapshot?: TodoItem[];
  isError?: boolean;
  /** 文件操作跟踪（P0-3）：压缩摘要携带；可选，旧事件回放无此字段也兼容 */
  fileOps?: FileOps;
}

export interface ApprovalAnswer {
  granted: boolean;
  scope?: "once" | "session" | "project" | "global";
  feedback?: string;
}

export type ApprovalHandler = (
  call: ToolCall,
  signal: AbortSignal,
) => Promise<ApprovalAnswer>;
