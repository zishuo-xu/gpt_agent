import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile, readOptional } from "../utils/fs.js";
import { createDiffPreview } from "../tools/atomic-file.js";
import type { AgentSessionManager } from "../core/session-manager.js";
import type {
  MemoryDocument,
  MemoryDocumentId,
  MemoryTimelineEntry,
} from "../shared/types.js";

export type { MemoryDocument, MemoryDocumentId, MemoryTimelineEntry };

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
      timeline: await this.#buildTimeline(documents),
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

  /**
   * 读取某次自动写入的留档：before（写时快照）与 after（文档当前内容）、
   * 统一格式 diff 及变更行统计。path 必须位于某记忆文档的 .history/ 目录内（防越界）。
   */
  async getHistory(
    rawPath: string,
  ): Promise<{
    before: string;
    after: string;
    diff: string;
    stats: { added: number; removed: number };
  }> {
    const resolved = path.resolve(rawPath);
    const resolvedBase = path.basename(resolved, ".md");
    const definition = memoryDefinitions(this.#cwd, this.#homeDir).find(
      (candidate) => {
        // 同一记忆目录下多个文档共用 .history/：目录 + 文件名前缀双重匹配
        const historyDir = path.join(
          path.dirname(candidate.path),
          HISTORY_DIR,
        );
        const candidateBase = path.basename(candidate.path, ".md");
        return (
          path.dirname(resolved) === historyDir &&
          resolvedBase.startsWith(`${candidateBase}-`)
        );
      },
    );
    if (!definition) {
      throw new MemoryHistoryError("路径不在记忆留档目录内", 400);
    }
    const before = await readOptional(resolved);
    if (before === null) {
      throw new MemoryHistoryError("留档文件不存在", 404);
    }
    const after = (await readOptional(definition.path)) ?? "";
    const diff = createDiffPreview(definition.path, before, after);
    return {
      before,
      after,
      diff,
      stats: countDiffStats(diff),
    };
  }

  async #buildTimeline(
    documents: MemoryDocument[],
  ): Promise<MemoryTimelineEntry[]> {
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
        const historyPath = await this.#historyPathFor(absolute, record.ts);
        // 变更统计：留档（before）vs 文档当前内容（list 已读），与展开 diff 口径一致
        const historyStats = historyPath
          ? await this.#historyStatsFor(
              historyPath,
              documents.find((document) => document.id === documentId)
                ?.content ?? "",
            )
          : undefined;
        timeline.push({
          ts: record.ts,
          sessionId: summary.id,
          sessionTitle: summary.title,
          documentId,
          summary: event.summary,
          ...(historyPath ? { historyPath } : {}),
          ...(historyStats ? { historyStats } : {}),
        });
      }
    }
    return timeline.sort((a, b) => b.ts.localeCompare(a.ts));
  }

  /** 留档 vs 文档当前内容的变更行统计（与展开 diff 同一口径） */
  async #historyStatsFor(
    historyPath: string,
    currentContent: string,
  ): Promise<{ added: number; removed: number } | undefined> {
    const before = await readOptional(historyPath);
    if (before === null) return undefined;
    const diff = createDiffPreview(
      path.basename(historyPath),
      before,
      currentContent,
    );
    return countDiffStats(diff);
  }

  /**
   * 匹配条目 ts 前 HISTORY_WINDOW_MS 窗口内、mtime 最近的留档文件。
   * 窗口匹配对手动编辑免疫：手动编辑不产生对应会话事件，无事件则无条目；
   * 同一窗口内若恰好有手动编辑的留档（无事件对应），不影响本条目命中。
   */
  async #historyPathFor(    filePath: string,
    ts: string,
  ): Promise<string | undefined> {
    const dir = path.join(path.dirname(filePath), HISTORY_DIR);
    const base = path.basename(filePath, path.extname(filePath));
    const targetTs = Date.parse(ts);
    if (Number.isNaN(targetTs)) return undefined;
    const files = await readdir(dir).catch(() => []);
    let best: { file: string; mtime: number } | undefined;
    for (const file of files) {
      if (!file.startsWith(`${base}-`) || !file.endsWith(".md")) continue;
      const info = await stat(path.join(dir, file)).catch(() => undefined);
      if (!info) continue;
      const mtime = info.mtimeMs;
      if (
        mtime <= targetTs &&
        targetTs - mtime <= HISTORY_WINDOW_MS &&
        (!best || mtime > best.mtime)
      ) {
        best = { file, mtime };
      }
    }
    return best ? path.join(dir, best.file) : undefined;
  }
}

/** 留档目录名（与 memory-history.ts 的 MemoryHistoryKeeper 约定一致） */
const HISTORY_DIR = ".history";
/** 时间线条目与留档文件的匹配窗口（ms）：工具执行耗时通常 < 数秒 */
const HISTORY_WINDOW_MS = 60_000;

export class MemoryHistoryError extends Error {
  readonly status: 400 | 404;
  constructor(message: string, status: 400 | 404) {
    super(message);
    this.status = status;
  }
}

/**
 * 从统一格式 diff 统计变更行数（排除 ---/+++ 头，口径与 DiffOrOutput 展示一致）。
 * 记忆文件为 markdown 列表时内容行以 "- " 开头——此处统计的是 diff 前缀符号
 * （行首第一个字符），与内容无关。
 */
export function countDiffStats(diff: string): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

export function memoryDefinitions(cwd: string, homeDir: string) {
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
