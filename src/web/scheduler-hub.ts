import path from "node:path";
import {
  RunScheduler,
  type ScheduledTask,
} from "../core/scheduler.js";

/**
 * 定时任务中心（web server 宿主）：
 * - 按项目缓存 RunScheduler（stateDir/projects/<key>/scheduled.jsonl）
 * - ensureLoaded：首次访问时从磁盘加载（幂等），保证新增/删除/查询看到持久化任务
 * - tick(now)：轮询所有已加载项目调度器，把到期任务交给 onDue 回调执行
 */
export class SchedulerHub {
  readonly #stateRoot: string;
  readonly #schedulers = new Map<string, RunScheduler>();
  readonly #loaded = new Set<string>();

  constructor(stateRoot: string) {
    this.#stateRoot = stateRoot;
  }

  /** 取（或创建）项目的调度器实例；不含磁盘加载，配合 ensureLoaded 使用 */
  schedulerFor(projectKey: string): RunScheduler {
    let scheduler = this.#schedulers.get(projectKey);
    if (!scheduler) {
      scheduler = new RunScheduler(
        path.join(
          this.#stateRoot,
          "projects",
          projectKey,
          "scheduled.jsonl",
        ),
      );
      this.#schedulers.set(projectKey, scheduler);
    }
    return scheduler;
  }

  /** 首次访问时从磁盘加载；重复调用幂等（避免二次 load 覆盖内存态） */
  async ensureLoaded(projectKey: string): Promise<RunScheduler> {
    const scheduler = this.schedulerFor(projectKey);
    if (!this.#loaded.has(projectKey)) {
      await scheduler.load();
      this.#loaded.add(projectKey);
    }
    return scheduler;
  }

  async tick(
    now = new Date(),
    onDue: (projectKey: string, task: ScheduledTask) => void | Promise<void>,
  ): Promise<void> {
    for (const [projectKey, scheduler] of this.#schedulers) {
      for (const task of scheduler.due(now)) {
        try {
          await onDue(projectKey, task);
        } catch (error) {
          // 单个任务失败不阻塞其他定时任务（宿主记录日志）
          console.error(
            `[scheduler] 定时任务 ${task.id} 启动失败：`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
  }
}
