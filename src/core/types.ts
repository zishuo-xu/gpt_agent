export type PermissionMode = "strict" | "normal" | "trust";
export type PermissionEffect = "allow" | "ask" | "deny";
export type ToolName =
  | "Read"
  | "Grep"
  | "Glob"
  | "TodoWrite"
  | "Task"
  | "Edit"
  | "MultiEdit"
  | "Write"
  | "Bash";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
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
  tool: ToolName;
  target: string;
  args: unknown;
  purpose?: string;
}

export type AgentEvent =
  | {
      type: "user";
      text: string;
      modelText?: string;
      queueId?: string;
    }
  | { type: "user_queued"; text: string; queueId: string }
  | { type: "permission_mode_changed"; mode: PermissionMode }
  | {
      type: "context_compacted";
      summary: string;
      ratio: number;
      keepFromSeq: number;
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
    }
  | {
      type: "run_started";
      taskId: string;
      description: string;
      permissionMode: PermissionMode;
      deadline?: string;
      budgetCny?: number;
      hardRules: PermissionRule[];
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
  | { type: "todo_update"; todos: TodoItem[] }
  | { type: "tool_call"; call: ToolCall }
  | {
      type: "tool_result";
      callId: string;
      summary: string;
      output?: unknown;
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
    }
  | { type: "done" }
  | { type: "need_user"; question: string }
  | { type: "error"; message: string }
  | { type: "notify"; level: "info" | "warn" | "error"; message: string }
  | { type: "interrupted"; scope: "model" | "tool" | "loop" };

export interface RecordedEvent {
  seq: number;
  ts: string;
  sessionId: string;
  event: AgentEvent;
}

export interface ToolExecutionResult {
  summary: string;
  output?: unknown;
  traceOutput?: unknown;
  aborted?: boolean;
  todoSnapshot?: TodoItem[];
  isError?: boolean;
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
