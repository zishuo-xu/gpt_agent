export type TaskMode = "direct" | "plan";

export interface DevTaskScenario {
  id: string;
  title: string;
  description: string;
  fixture: string;
  check: string;
  planSteps: string[];
  prepare: (cwd: string) => Array<{ tool: string; target: string; args: unknown }>;
}

export interface TaskRunMetrics {
  scenario: string;
  mode: TaskMode;
  outcomePassed: boolean;
  declaredCompleted: boolean;
  reliableCompletion: boolean;
  falseCompletion: boolean;
  interventions: number;
  acceptanceAttempts: number;
  toolCalls: number;
  errors: number;
  tokens: { input: number; output: number; cached: number; total: number };
  cost: number;
  durationMs: number;
  planUnits: { total: number; completed: number; verified: number; pending: number; blocked: number };
  verification: {
    command: string;
    commandPassed: boolean;
    shapePassed: boolean;
    output: string;
  };
  workspace?: string;
  workspaceKept: boolean;
  error?: string;
}

export interface TaskEvalReport {
  version: 1;
  kind: "provider-free-harness" | "real-model";
  generatedAt: string;
  provider?: string;
  model?: string;
  fixtureRevision: string;
  runs: TaskRunMetrics[];
  summary: {
    taskCompletionRate: number;
    reliableCompletionRate: number;
    falseCompletionCount: number;
    interventionCount: number;
    byMode: Record<TaskMode, {
      total: number;
      outcomePassed: number;
      reliableCompletion: number;
      interventions: number;
      acceptanceAttempts: number;
      averageTokens: number;
      averageCost: number;
      averageDurationMs: number;
    }>;
  };
}
