/**
 * 前后端共享的 API 类型（纯类型，零运行时；前端经 @shared 别名引用，构建期擦除）。
 * 后端各模块（core/session、web/memory、model/test-connection、config/schema）
 * 从这里 re-export，前端不再手写后端类型副本。
 */
import type {
  PermissionMode,
  RecordedEvent,
  SessionBranch,
  TodoItem,
} from "../core/types.js";

export type {
  PermissionMode,
  RecordedEvent,
  SessionBranch,
  TodoItem,
} from "../core/types.js";

export type SessionStatus =
  | "idle"
  | "running"
  | "waiting_permission"
  | "done"
  | "error"
  | "interrupted";

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  permissionMode: PermissionMode;
  createdAt: string;
  updatedAt: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  /** 累计缓存浪费 token（仅异常失效；压缩不计） */
  totalMissedTokens: number;
  /** 累计缓存浪费费用（元） */
  totalMissedCostCny: number;
  totalCostCny: number;
  todos: TodoItem[];
  toolCallCount: number;
  kind: "interactive" | "run";
  /** 首条用户消息文本（Web 会话搜索用）；截断至 80 字符 */
  firstMessage?: string;
  /** 崩溃中断的任务（进程重启后存在；Web 展示「续跑」入口） */
  interruptedTask?: {
    taskId: string;
    description: string;
  };
}

export type MemoryDocumentId =
  | "preferences"
  | "conventions"
  | "pitfalls"
  | "decisions";

export interface MemoryDocument {
  id: MemoryDocumentId;
  label: string;
  scope: "global" | "project";
  path: string;
  content: string;
  updatedAt?: string;
}

export interface MemoryTimelineEntry {
  ts: string;
  sessionId: string;
  sessionTitle: string;
  documentId: MemoryDocumentId;
  summary: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  reachable: boolean;
  providerId: string;
  model: string;
  latencyMs: number;
  message: string;
}

export interface ConfigFieldSchema {
  key: string;
  type:
    | "provider[]"
    | "role-models"
    | "permissions"
    | "context"
    | "string"
    | "number"
    | "boolean"
    | "select";
  title: string;
  description: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ label: string; value: string }>;
  hot?: boolean;
  /** 复合字段的渲染器标识，前端按此分派专用组件 */
  renderer?: "provider" | "role-models" | "permissions" | "context";
}
