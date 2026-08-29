import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "../utils/fs.js";
import type { ExperimentWorkspaceSnapshot } from "./experiment-workspace.js";

export type RunWorkspaceMode = "project" | "isolated";

export interface RunWorkspaceState {
  version: 1;
  mode: "isolated";
  sourceCwd: string;
  snapshot: ExperimentWorkspaceSnapshot;
  createdAt: string;
}

export function runWorkspaceSidecarPath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.workspace.json`);
}

export async function writeRunWorkspaceState(
  sessionsDir: string,
  sessionId: string,
  state: RunWorkspaceState,
): Promise<void> {
  await atomicWriteFile(
    runWorkspaceSidecarPath(sessionsDir, sessionId),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

export async function readRunWorkspaceState(
  sessionsDir: string,
  sessionId: string,
): Promise<RunWorkspaceState | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(runWorkspaceSidecarPath(sessionsDir, sessionId), "utf8"),
    );
    if (!isRunWorkspaceState(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function deleteRunWorkspaceState(
  sessionsDir: string,
  sessionId: string,
): Promise<void> {
  await unlink(runWorkspaceSidecarPath(sessionsDir, sessionId)).catch(() => undefined);
}

function isRunWorkspaceState(value: unknown): value is RunWorkspaceState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<RunWorkspaceState>;
  const snapshot = state.snapshot;
  return state.version === 1 && state.mode === "isolated" &&
    typeof state.sourceCwd === "string" && typeof state.createdAt === "string" &&
    Boolean(snapshot && typeof snapshot === "object" &&
      typeof snapshot.worktreePath === "string" && typeof snapshot.cwd === "string" &&
      typeof snapshot.gitRoot === "string" && typeof snapshot.head === "string" &&
      Array.isArray(snapshot.untrackedCopied) && Array.isArray(snapshot.warnings));
}
