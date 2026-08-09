import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
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
}

/**
 * 定时任务调度器（纯核心逻辑，与宿主解耦）：
 * - 持久化：stateDir/scheduled.jsonl（原子写，坏行跳过）
 * - due(now)：返回到期任务；一次性任务到期即移除，周期任务重排到下一次
 * - 宿主（web server ticker / CLI）负责把 due 任务接到真实执行
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

  /** 到期任务：一次性删除；周期任务按周期重排（从原定时刻起算避免累积漂移） */
  due(now = new Date()): ScheduledTask[] {
    const fired: ScheduledTask[] = [];
    for (const task of this.#tasks) {
      const atMs = new Date(task.at).getTime();
      if (atMs > now.getTime()) continue;
      fired.push(structuredClone(task));
      if (task.everyMinutes && task.everyMinutes > 0) {
        let next = new Date(atMs);
        while (next.getTime() <= now.getTime()) {
          next = new Date(next.getTime() + task.everyMinutes * 60_000);
        }
        task.at = next.toISOString();
      } else {
        this.#tasks = this.#tasks.filter((candidate) => candidate.id !== task.id);
      }
    }
    if (fired.length > 0) void this.persist();
    return fired;
  }

  async persist(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const content = this.#tasks
      .map((task) => JSON.stringify(task))
      .join("\n");
    await atomicWriteFile(this.#file, content + (content ? "\n" : ""));
  }
}
