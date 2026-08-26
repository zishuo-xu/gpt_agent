import type { AgentEvent, PermissionMode, ModelPricing } from "../core/types.js";
import type { ModelClient } from "../model/types.js";

export type EvalScenario =
  | "read"
  | "edit"
  | "recovery"
  | "deny"
  | "approval"
  | "cost"
  | "budget"
  | "replay"
  | "branch"
  | "acceptance"
  | "flight";

export interface EvalMetrics {
  scenario: EvalScenario;
  success: boolean;
  testsPassed: boolean;
  verification: string[];
  toolCalls: number;
  toolErrors: number;
  tokens: { input: number; output: number; cached: number; total: number };
  cost: number;
  durationMs: number;
  approvals: number;
  violations: number;
  recovery: { attempted: boolean; succeeded: boolean; steps: number };
  events: string[];
  error?: string;
}

export interface EvalReport {
  version: 1;
  generatedAt: string;
  scenarios: EvalMetrics[];
  summary: {
    success: boolean;
    passedScenarios: number;
    total: number;
    totalTokens: number;
    totalCost: number;
    totalDurationMs: number;
  };
}

export interface ScriptedAction {
  tool: string;
  target: string;
  args: unknown;
}

export type ScriptedStep =
  | { kind: "respond"; text?: string; action?: ScriptedAction }
  | { kind: "throw"; error: Error };

export type EventRecord = { event: AgentEvent; seq: number };

export interface EvalOptions {
  /** Override the permission mode for scenarios that do not need a run task. */
  permissionMode?: PermissionMode;
  /**
   * 真实模型注入缝：提供后场景改用 createClient(context) 返回的客户端
   * （每次调用新建实例，一次会话一个）与 injected.pricing.main 单价，
   * 不再使用 ScriptedModelClient 与占位价格。
   */
  injected?: {
    createClient: (context: { scenario: EvalScenario; cwd: string }) => ModelClient;
    pricing: Partial<Record<"main" | "cheap" | "explore", ModelPricing>>;
  };
}

export interface DemoResult {
  success: boolean;
  initialTestsPassed: boolean;
  finalTestsPassed: boolean;
  changedFiles: string[];
  workspace: string;
  workspaceKept: boolean;
  metrics: EvalMetrics;
}
