import type { AgentSessionSummary } from "../core/session.js";

export interface DayBucket {
  /** 按本地时区归日的 YYYY-MM-DD */
  day: string;
  sessions: number;
  completed: number;
  failed: number;
  tokens: number;
  costCny: number;
}

export interface SessionStats {
  totals: {
    sessions: number;
    running: number;
    completed: number;
    failed: number;
    interrupted: number;
    tokens: number;
    costCny: number;
    /** 无人值守（kind=run）会话数 */
    runSessions: number;
  };
  byDay: DayBucket[];
  /** 按创建时间倒序的会话明细（前端表格直接消费 summary 字段） */
  sessions: AgentSessionSummary[];
}

function localDay(iso: string): string {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 任务统计聚合：会话汇总按天分桶（本地时区）+ 总量计数。
 * 纯函数，便于单元测试；/api/stats 路由直接消费。
 */
export function computeSessionStats(
  summaries: AgentSessionSummary[],
): SessionStats {
  const totals = {
    sessions: 0,
    running: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
    tokens: 0,
    costCny: 0,
    runSessions: 0,
  };
  const byDay = new Map<string, DayBucket>();

  for (const summary of summaries) {
    totals.sessions += 1;
    totals.tokens += summary.totalInputTokens;
    totals.costCny += summary.totalCostCny;
    if (summary.kind === "run") totals.runSessions += 1;
    switch (summary.status) {
      case "running":
        totals.running += 1;
        break;
      case "done":
        totals.completed += 1;
        break;
      case "error":
        totals.failed += 1;
        break;
      case "interrupted":
        totals.interrupted += 1;
        break;
      // idle / waiting_permission 不进入终态计数
      default:
        break;
    }

    const day = localDay(summary.createdAt);
    const bucket = byDay.get(day) ?? {
      day,
      sessions: 0,
      completed: 0,
      failed: 0,
      tokens: 0,
      costCny: 0,
    };
    bucket.sessions += 1;
    bucket.tokens += summary.totalInputTokens;
    bucket.costCny += summary.totalCostCny;
    if (summary.status === "done") bucket.completed += 1;
    if (summary.status === "error") bucket.failed += 1;
    byDay.set(day, bucket);
  }

  const byDaySorted = [...byDay.values()].sort((a, b) =>
    a.day.localeCompare(b.day),
  );
  const sessionsSorted = [...summaries].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  return { totals, byDay: byDaySorted, sessions: sessionsSorted };
}
