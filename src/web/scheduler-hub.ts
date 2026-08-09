import path from "node:path";
import {
  RunScheduler,
  type ScheduledTask,
} from "../core/scheduler.js";

/** 启动失败重试间隔（分钟） */
export const FAIL_RETRY_MINUTES = 5;
/** 连续失败最大次数（超过后丢弃任务并告警） */
export const MAX_ATTEMPTS = 3;
/** 预算护栏顺延（一次性任务 +24h；周期任务保相位重排到下一周期） */
export const BUDGET_RETRY_MS = 24 * 3600_000;

/**
 * 定时任务中心（web server 宿主）：
 * - 按项目缓存 RunScheduler（stateDir/projects/<key>/scheduled.jsonl）
 * - ensureLoaded：首次访问时从磁盘加载（幂等），保证新增/删除/查询看到持久化任务
 * - tick(now)：轮询所有已加载项目调度器，把到期任务交给 onDue 回调执行，
 *   并按执行结果回告调度器：
 *   - onDue 返回 true → confirm（一次性移除 / 周期重排）
 *   - onDue 返回 false（预算护栏拒绝）→ postpone 顺延
 *   - onDue 抛错 → retry（5 分钟后重试，最多 3 次后丢弃）
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
    onDue: (projectKey: string, task: ScheduledTask) => boolean | Promise<boolean>,
  ): Promise<void> {
    for (const [projectKey, scheduler] of this.#schedulers) {
      for (const task of scheduler.due(now)) {
        try {
          const started = await onDue(projectKey, task);
          if (started === false) {
            // 预算护栏拒绝：不视为失败，顺延后继续保留
            await scheduler.postpone(task, BUDGET_RETRY_MS, now);
            console.warn(
              `[scheduler] 定时任务 ${task.id} 因预算护栏顺延（24 小时后重试）`,
            );
          } else {
            await scheduler.confirm(task, now);
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (
            !(await scheduler.retry(
              task,
              FAIL_RETRY_MINUTES * 60_000,
              MAX_ATTEMPTS,
              now,
            ))
          ) {
            console.error(
              `[scheduler] 定时任务 ${task.id} 连续 ${MAX_ATTEMPTS} 次启动失败，已丢弃：${message}`,
            );
          } else {
            console.error(
              `[scheduler] 定时任务 ${task.id} 启动失败（${message}），${FAIL_RETRY_MINUTES} 分钟后重试（第 ${task.attempts ?? 0} 次）`,
            );
          }
        }
      }
    }
  }
}
