import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "../utils/fs.js";
import { readJsonl } from "../utils/fs.js";
import type { RunTaskOptions } from "./run-task.js";

/** 定时 /run 任务（持久化于项目 stateDir 的 scheduled.jsonl） */
export interface ScheduledTask {
  id: string;
  /** 原始 /run 命令（到期时重新解析执行，与手工启动路径一致） */
  command: string;
  /** 下次执行时间（ISO） */
  at: string;
  /** 周期（分钟）；缺省一次性 */
  everyMinutes?: number;
  createdAt: string;
  /** 注册时解析的任务选项（含 goal/bounds/budget 等） */
  options: RunTaskOptions;
  /** 连续启动失败次数（持久化，重启不重置）；达上限后任务被丢弃 */
  attempts?: number;
}

/**
 * 定时任务调度器（纯核心逻辑，与宿主解耦）：
 * - 持久化：stateDir/scheduled.jsonl（原子写，坏行跳过）
 * - due(now)：只读返回到期任务，不修改状态——执行结果由宿主回告：
 *   - confirm(task)：启动成功——一次性任务移除，周期任务按原时刻重排（不累积漂移）
 *   - retry(task)：启动失败——顺延 delayMs 重试，attempts 超上限则丢弃
 *   - postpone(task)：预算护栏顺延——周期任务保相位，一次性任务 +delayMs
 */
export class RunScheduler {
  readonly #file: string;
  #tasks: ScheduledTask[] = [];

  constructor(file: string) {
    this.#file = file;
  }

  async load(): Promise<void> {
    let records: ScheduledTask[] = [];
    try {
      ({ records } = await readJsonl<ScheduledTask>(this.#file));
    } catch (error) {
      // 首次运行（文件不存在）视为空表；其余读取错误向上抛
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    this.#tasks = records
      .filter((record) => {
        return (
          typeof record.id === "string" &&
          typeof record.command === "string" &&
          typeof record.at === "string" &&
          typeof record.createdAt === "string" &&
          typeof record.options?.description === "string" &&
          !Number.isNaN(new Date(record.at).getTime())
        );
      })
      .map((record) => {
        const task: ScheduledTask = {
          id: record.id,
          command: record.command,
          at: record.at,
          createdAt: record.createdAt,
          options: record.options,
        };
        if (typeof record.everyMinutes === "number") {
          task.everyMinutes = record.everyMinutes;
        }
        if (typeof record.attempts === "number") {
          task.attempts = record.attempts;
        }
        return task;
      });
  }

  list(): ScheduledTask[] {
    return structuredClone(this.#tasks);
  }

  async add(task: Omit<ScheduledTask, "id" | "createdAt">): Promise<ScheduledTask> {
    const scheduled: ScheduledTask = {
      ...task,
      id: randomUUID().slice(0, 8),
      createdAt: new Date().toISOString(),
    };
    this.#tasks.push(scheduled);
    await this.persist();
    return structuredClone(scheduled);
  }

  async remove(id: string): Promise<boolean> {
    const before = this.#tasks.length;
    this.#tasks = this.#tasks.filter((task) => task.id !== id);
    if (this.#tasks.length === before) return false;
    await this.persist();
    return true;
  }

  /** 到期任务（只读；执行结果用 confirm/retry/postpone 回告） */
  due(now = new Date()): ScheduledTask[] {
    return this.#tasks
      .filter((task) => new Date(task.at).getTime() <= now.getTime())
      .map((task) => structuredClone(task));
  }

  /** 启动成功：一次性任务移除；周期任务按原时刻重排到下一个 > now 的周期 */
  async confirm(task: ScheduledTask, now = new Date()): Promise<void> {
    const current = this.#find(task.id);
    if (!current) return;
    if (current.everyMinutes && current.everyMinutes > 0) {
      this.#advanceToNext(current, now);
    } else {
      this.#tasks = this.#tasks.filter((candidate) => candidate.id !== task.id);
    }
    await this.persist();
  }

  /** 预算护栏顺延：周期任务保相位（重排到下一周期），一次性任务 +delayMs */
  async postpone(
    task: ScheduledTask,
    delayMs: number,
    now = new Date(),
  ): Promise<void> {
    const current = this.#find(task.id);
    if (!current) return;
    if (current.everyMinutes && current.everyMinutes > 0) {
      this.#advanceToNext(current, now);
    } else {
      current.at = new Date(now.getTime() + delayMs).toISOString();
    }
    await this.persist();
  }

  /**
   * 启动失败重试：attempts+1 后顺延 delayMs；超过 maxAttempts 丢弃任务。
   * 返回 false 表示已丢弃。
   */
  async retry(
    task: ScheduledTask,
    delayMs: number,
    maxAttempts: number,
    now = new Date(),
  ): Promise<boolean> {
    const current = this.#find(task.id);
    if (!current) return false;
    const attempts = (current.attempts ?? 0) + 1;
    if (attempts > maxAttempts) {
      this.#tasks = this.#tasks.filter((candidate) => candidate.id !== task.id);
      await this.persist();
      return false;
    }
    current.attempts = attempts;
    current.at = new Date(now.getTime() + delayMs).toISOString();
    await this.persist();
    return true;
  }

  #find(id: string): ScheduledTask | undefined {
    return this.#tasks.find((task) => task.id === id);
  }

  /** 从原定时刻起算推进到下一个 > now 的周期（避免累积漂移） */
  #advanceToNext(task: ScheduledTask, now: Date): void {
    const period = (task.everyMinutes ?? 0) * 60_000;
    let next = new Date(new Date(task.at).getTime());
    while (next.getTime() <= now.getTime()) {
      next = new Date(next.getTime() + period);
    }
    task.at = next.toISOString();
  }

  async persist(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const content = this.#tasks
      .map((task) => JSON.stringify(task))
      .join("\n");
    await atomicWriteFile(this.#file, content + (content ? "\n" : ""));
  }
}
