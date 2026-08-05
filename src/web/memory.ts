import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile, readOptional } from "../utils/fs.js";
import type { AgentSessionManager } from "../core/session-manager.js";

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

export class MemoryService {
  readonly #cwd: string;
  readonly #homeDir: string;
  readonly #sessions: AgentSessionManager | undefined;

  constructor(options: {
    cwd: string;
    homeDir?: string;
    sessions?: AgentSessionManager;
  }) {
    this.#cwd = options.cwd;
    this.#homeDir = options.homeDir ?? os.homedir();
    this.#sessions = options.sessions;
  }

  async list(): Promise<{
    documents: MemoryDocument[];
    timeline: MemoryTimelineEntry[];
  }> {
    const documents = await Promise.all(
      memoryDefinitions(this.#cwd, this.#homeDir).map(
        async (definition) => {
          const content = await readOptional(definition.path) ?? "";
          const info = await stat(definition.path).catch(() => undefined);
          return {
            ...definition,
            content,
            ...(info
              ? { updatedAt: info.mtime.toISOString() }
              : {}),
          };
        },
      ),
    );
    return {
      documents,
      timeline: this.#buildTimeline(documents),
    };
  }

  async write(
    id: MemoryDocumentId,
    content: string,
  ): Promise<MemoryDocument> {
    const definition = memoryDefinitions(
      this.#cwd,
      this.#homeDir,
    ).find((candidate) => candidate.id === id);
    if (!definition) throw new Error("未知记忆文档");
    await atomicWriteFile(definition.path, content);
    const info = await stat(definition.path);
    return {
      ...definition,
      content,
      updatedAt: info.mtime.toISOString(),
    };
  }

  #buildTimeline(
    documents: MemoryDocument[],
  ): MemoryTimelineEntry[] {
    if (!this.#sessions) return [];
    const pathToDocument = new Map(
      documents.map((document) => [
        path.resolve(document.path),
        document.id,
      ]),
    );
    const timeline: MemoryTimelineEntry[] = [];
    for (const summary of this.#sessions.list()) {
      const session = this.#sessions.get(summary.id);
      if (!session) continue;
      const calls = new Map<
        string,
        { target: string; tool: string }
      >();
      for (const record of session.events()) {
        const event = record.event;
        if (event.type === "tool_call") {
          calls.set(event.call.id, {
            target: event.call.target,
            tool: event.call.tool,
          });
          continue;
        }
        if (event.type !== "tool_result" || event.isError) {
          continue;
        }
        const call = calls.get(event.callId);
        if (
          !call ||
          !["Edit", "MultiEdit", "Write"].includes(call.tool)
        ) {
          continue;
        }
        const absolute = path.resolve(this.#cwd, call.target);
        const documentId =
          pathToDocument.get(absolute) ??
          pathToDocument.get(path.resolve(call.target));
        if (!documentId) continue;
        timeline.push({
          ts: record.ts,
          sessionId: summary.id,
          sessionTitle: summary.title,
          documentId,
          summary: event.summary,
        });
      }
    }
    return timeline.sort((a, b) => b.ts.localeCompare(a.ts));
  }
}

function memoryDefinitions(cwd: string, homeDir: string) {
  return [
    {
      id: "preferences" as const,
      label: "preferences（全局）",
      scope: "global" as const,
      path: path.join(homeDir, ".myagent", "MEMORY.md"),
    },
    ...(["conventions", "pitfalls", "decisions"] as const).map(
      (id) => ({
        id,
        label: `${path.basename(cwd)} / ${id}`,
        scope: "project" as const,
        path: path.join(cwd, ".myagent", "memory", `${id}.md`),
      }),
    ),
  ];
}
