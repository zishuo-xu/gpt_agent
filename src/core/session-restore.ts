import type { TaskBox } from "./run-task.js";
import type { AgentEvent, RecordedEvent } from "./types.js";

/** 事件流中首条 user 消息文本（截断 80 字符）；无则返回 undefined */
export function firstUserText(
  records: readonly RecordedEvent[],
): string | undefined {
  const record = records.find((item) => item.event.type === "user");
  if (!record || record.event.type !== "user") return undefined;
  const text = record.event.text.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * 从事件流检测中断任务：最近的 run_started 若无同 taskId 的 run_finished
 * 跟随（进程崩溃残留），返回该任务信息与持久化的完整选项。
 */
export function interruptedTaskFrom(
  records: readonly RecordedEvent[] | undefined,
):
  | {
      taskId: string;
      description: string;
      options?: NonNullable<
        Extract<AgentEvent, { type: "run_started" }>["taskOptions"]
      >;
    }
  | undefined {
  if (!records) return undefined;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const event = records[index]?.event;
    if (event?.type !== "run_started") continue;
    const finished = records
      .slice(index + 1)
      .some(
        (record) =>
          record.event.type === "run_finished" &&
          record.event.taskId === event.taskId,
      );
    if (!finished) {
      return {
        taskId: event.taskId,
        description: event.description,
        ...(event.taskOptions ? { options: event.taskOptions } : {}),
      };
    }
  }
  return undefined;
}

/** 续跑指令：不重复完整任务 prompt（原 prompt 已在事件流历史），只注入恢复说明 */
export function resumePrompt(taskBox: TaskBox, totalCostCny: number): string {
  return [
    `[任务续跑 #${taskBox.id}]`,
    `之前的无人值守任务因进程重启而中断，现在继续。`,
    `任务：${taskBox.options.description}`,
    taskBox.options.goal
      ? `机器验收目标：${taskBox.options.goal}`
      : "机器验收目标：未指定；完成合理验证后自然停止。",
    taskBox.options.budgetCny === undefined
      ? ""
      : `本任务剩余预算：¥${Math.max(0, taskBox.options.budgetCny - totalCostCny).toFixed(2)}`,
    "",
    "先评估已完成的进度（读取文件或检查 git 状态确认），再继续未完成的部分。",
    "持续工作直至目标完成或任务盒要求收尾；收尾固定包含改动与验证总结、todo 快照、值得写入记忆的稳定事实。",
  ]
    .filter(Boolean)
    .join("\n");
}
