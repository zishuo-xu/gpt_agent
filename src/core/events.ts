import { EventEmitter } from "node:events";
import { mkdir, appendFile, readFile } from "node:fs/promises";
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

  constructor(filePath: string, sessionId: string) {
    this.#filePath = filePath;
    this.#sessionId = sessionId;
  }

  attach(
    bus: AgentEventBus,
    getBranchId?: () => string,
  ): () => void {
    return bus.subscribe((event) => {
      this.#writeTail = this.#writeTail.then(async () => {
        await this.#initializeSequence();
        const record: RecordedEvent = {
          seq: ++this.#seq,
          ts: new Date().toISOString(),
          sessionId: this.#sessionId,
          branchId: getBranchId?.() ?? ROOT_BRANCH,
          event,
        };
        await mkdir(path.dirname(this.#filePath), { recursive: true });
        await appendFile(this.#filePath, `${JSON.stringify(record)}\n`, "utf8");
      });
    });
  }

  async flush(): Promise<void> {
    await this.#writeTail;
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
  turn: number;
  ts: string;
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

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  record(
    trace: Omit<AgentTurnTrace, "turn" | "ts">,
  ): void {
    this.#writeTail = this.#writeTail.then(async () => {
      await this.#initializeTurn();
      const record: AgentTurnTrace = {
        turn: ++this.#turn,
        ts: new Date().toISOString(),
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
