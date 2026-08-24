import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { readJsonl } from "../utils/fs.js";
import type { AgentEvent, RecordedEvent } from "./types.js";
import type { ToolCall } from "./types.js";
import { ROOT_BRANCH } from "./branch.js";

export class AgentEventBus {
  readonly #emitter = new EventEmitter();

  emit(event: AgentEvent): void {
    this.#emitter.emit("event", event);
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#emitter.on("event", listener);
    return () => this.#emitter.off("event", listener);
  }
}

export class SessionStore {
  readonly #filePath: string;
  readonly #sessionId: string;
  #seq = 0;
  #initialized = false;
  #writeTail: Promise<void> = Promise.resolve();
  /** 最近一次写盘失败（flush 时显式报告一次后清除） */
  #writeError: unknown | undefined;
  /** 关闭后事件不再落盘（会话删除场景：文件 unlink 后不得被重建） */
  #closed = false;

  constructor(filePath: string, sessionId: string) {
    this.#filePath = filePath;
    this.#sessionId = sessionId;
  }

  /** 关闭写链：后续事件静默丢弃（删除会话时调用，防 unlink 后文件被重建） */
  close(): void {
    this.#closed = true;
  }

  attach(
    bus: AgentEventBus,
    getBranchId?: () => string,
  ): () => void {
    return bus.subscribe((event) => {
      if (this.#closed) return;
      this.#writeTail = this.#writeTail
        .then(async () => {
          await this.#initializeSequence();
          const record: RecordedEvent = {
            seq: ++this.#seq,
            ts: new Date().toISOString(),
            sessionId: this.#sessionId,
            branchId: getBranchId?.() ?? ROOT_BRANCH,
            event,
          };
          await mkdir(path.dirname(this.#filePath), { recursive: true });
          await appendFile(
            this.#filePath,
            `${JSON.stringify(record)}\n`,
            "utf8",
          );
        })
        .catch((error) => {
          // 单次写失败不断链：记录错误由 flush 显式报告，后续事件照常尝试落盘
          // （避免整条写链被一次失败毒化，后续事件静默丢写）
          this.#writeError = error;
        });
    });
  }

  async flush(): Promise<void> {
    await this.#writeTail;
    // 显式报告最近一次写失败（报告后清除，避免反复抛出；内存事件流仍完整）
    if (this.#writeError !== undefined) {
      const error = this.#writeError;
      this.#writeError = undefined;
      throw error;
    }
  }

  async readAll(): Promise<RecordedEvent[]> {
    await this.flush();
    try {
      const { records } = await readJsonl<RecordedEvent>(this.#filePath);
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async #initializeSequence(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    const existing = await this.readAllWithoutFlush();
    this.#seq = existing.at(-1)?.seq ?? 0;
  }

  async readAllWithoutFlush(): Promise<RecordedEvent[]> {
    try {
      const { records } = await readJsonl<RecordedEvent>(this.#filePath);
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

export interface AgentTurnTrace {
  /** v2 is written for new traces; absent on legacy records. */
  version?: 2;
  turn: number;
  ts: string;
  turnId?: string;
  branchId?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  eventSeqStart?: number;
  eventSeqEnd?: number;
  modelRole?: "main" | "cheap" | "explore";
  providerId?: string;
  model?: string;
  request?: unknown;
  response?: unknown;
  tools: Array<{
    call: ToolCall;
    permission: string;
    result?: unknown;
    ms: number;
  }>;
  usage?: { input: number; output: number; cached: number };
}

export class TraceStore {
  readonly #filePath: string;
  #turn = 0;
  #initialized = false;
  #writeTail: Promise<void> = Promise.resolve();
  /** 关闭后不再落盘（会话删除场景） */
  #closed = false;

  readonly #getBranchId: (() => string) | undefined;
  readonly #getEventSeq: (() => number) | undefined;

  constructor(
    filePath: string,
    options: {
      getBranchId?: () => string;
      getEventSeq?: () => number;
    } = {},
  ) {
    this.#filePath = filePath;
    this.#getBranchId = options.getBranchId;
    this.#getEventSeq = options.getEventSeq;
  }

  /** 关闭写链：后续 trace 静默丢弃 */
  close(): void {
    this.#closed = true;
  }

  record(trace: TraceRecordInput): void {
    if (this.#closed) return;
    // Capture correlation metadata at invocation time. The write queue may run
    // much later, after the branch or event counter has moved on.
    const endedAt = trace.endedAt ?? new Date().toISOString();
    const startedAt = trace.startedAt ?? endedAt;
    const branchId = trace.branchId ?? this.#getBranchId?.();
    const eventSeqStart = trace.eventSeqStart ?? this.#getEventSeq?.();
    const eventSeqEnd = trace.eventSeqEnd ?? this.#getEventSeq?.();
    const captured: Pick<AgentTurnTrace, "version" | "turnId" | "branchId" | "startedAt" | "endedAt" | "durationMs" | "eventSeqStart" | "eventSeqEnd"> = {
      version: 2 as const,
      turnId: trace.turnId ?? randomUUID(),
      startedAt,
      endedAt,
      durationMs:
        trace.durationMs ?? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
      ...(branchId === undefined ? {} : { branchId }),
      ...(eventSeqStart === undefined ? {} : { eventSeqStart }),
      ...(eventSeqEnd === undefined ? {} : { eventSeqEnd }),
    };
    this.#writeTail = this.#writeTail
      .then(async () => {
        await this.#initializeTurn();
        const record: AgentTurnTrace = {
          turn: ++this.#turn,
          ts: endedAt,
          ...captured,
          ...trace,
        };
        await mkdir(path.dirname(this.#filePath), {
          recursive: true,
        });
        await appendFile(
          this.#filePath,
          `${JSON.stringify(record)}\n`,
          "utf8",
        );
      })
      .catch(() => {
        // TraceStore 属调试数据：写失败静默隔离，不阻断主流程也不让 flush 报错
      });
  }

  async flush(): Promise<void> {
    await this.#writeTail;
  }

  async readAll(): Promise<AgentTurnTrace[]> {
    await this.flush();
    return await this.#readAllWithoutFlush();
  }

  async #initializeTurn(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    const existing = await this.#readAllWithoutFlush();
    this.#turn = existing.at(-1)?.turn ?? 0;
  }

  async #readAllWithoutFlush(): Promise<AgentTurnTrace[]> {
    try {
      const { records } = await readJsonl<AgentTurnTrace>(this.#filePath);
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

/** Input accepted by TraceStore; generated identity/timing fields are optional. */
export type TraceRecordInput = Omit<AgentTurnTrace, "turn" | "ts" | "version">;
