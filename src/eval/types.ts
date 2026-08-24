import type { AgentEvent, PermissionMode } from "../core/types.js";

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
