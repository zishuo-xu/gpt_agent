import type { AgentTurnTrace } from "./events.js";
import type { ConversationMessage } from "../model/types.js";
import type { ExperimentWorkspaceSnapshot } from "./experiment-workspace.js";

export type { ExperimentWorkspaceSnapshot } from "./experiment-workspace.js";

/** Persisted metadata for an isolated Flight Recorder experiment. */
export interface ExperimentSessionMeta {
  version: 1;
  parentSessionId: string;
  parentTurnId: string;
  parentEventSeq: number;
  projectCwd: string;
  workspaceSnapshot: ExperimentWorkspaceSnapshot;
  pinnedModel: ExperimentPinnedModel;
  systemPromptOverlay?: string;
  status: ExperimentSessionStatus;
  createdAt: string;
}

export type ExperimentSessionStatus =
  | "creating"
  | "ready"
  | "workspace_missing"
  | "model_unavailable";

export interface ExperimentPinnedModel {
  providerId: string;
  model: string;
}

/** Small public shape suitable for session lists and Web cards. */
export interface ExperimentSessionSummary {
  id: string;
  parentSessionId: string;
  parentTurnId: string;
  pinnedModel: ExperimentPinnedModel;
  status: ExperimentSessionStatus;
  createdAt: string;
  systemPromptOverlay?: string;
  workspacePath: string;
}

export interface ExperimentForkState {
  meta: ExperimentSessionMeta;
  conversation: ConversationMessage[];
}

/** Convert persisted metadata into a deliberately non-sensitive list summary. */
export function experimentSessionSummary(
  id: string,
  meta: ExperimentSessionMeta,
): ExperimentSessionSummary {
  return {
    id,
    parentSessionId: meta.parentSessionId,
    parentTurnId: meta.parentTurnId,
    pinnedModel: { ...meta.pinnedModel },
    status: meta.status,
    createdAt: meta.createdAt,
    ...(meta.systemPromptOverlay === undefined
      ? {}
      : { systemPromptOverlay: meta.systemPromptOverlay }),
    workspacePath: meta.workspaceSnapshot.cwd,
  };
}

export function isExperimentMeta(value: unknown): value is ExperimentSessionMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Partial<ExperimentSessionMeta>;
  return (
    meta.version === 1 &&
    typeof meta.parentSessionId === "string" &&
    typeof meta.parentTurnId === "string" &&
    typeof meta.parentEventSeq === "number" &&
    typeof meta.projectCwd === "string" &&
    typeof meta.workspaceSnapshot?.cwd === "string" &&
    typeof meta.workspaceSnapshot?.worktreePath === "string" &&
    typeof meta.pinnedModel?.providerId === "string" &&
    typeof meta.pinnedModel?.model === "string" &&
    typeof meta.status === "string" &&
    typeof meta.createdAt === "string"
  );
}

export function isExperimentForkState(value: unknown): value is ExperimentForkState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ExperimentForkState>;
  return isExperimentMeta(state.meta) && Array.isArray(state.conversation);
}

/** Public alias used by API adapters that need a trace list without internals. */
export type ExperimentTraceSummary = Pick<
  AgentTurnTrace,
  | "turn"
  | "turnId"
  | "branchId"
  | "startedAt"
  | "endedAt"
  | "durationMs"
  | "providerId"
  | "model"
  | "usage"
> & { forkable: boolean };
