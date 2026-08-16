import { shouldShowCacheMissNotice } from "./core/cache-stats.js";
import type { AgentEvent } from "./core/types.js";

/** 渲染与输入处理共享的审批状态（ask_permission 置位，permission_denied/解析成功清除） */
export interface ApprovalState {
  pendingCallId: string;
}

/**
 * CLI 事件渲染器（30+ 事件分支的纯渲染逻辑，与输入循环解耦）：
 * 输出经注入的 output 回调，审批状态经 approvalState 可变引用。
 */
export function createEventRenderer(options: {
  output: (text: string) => void;
  approvalState: ApprovalState;
  showCacheMissNotices: boolean;
}): (event: AgentEvent) => void {
  const { output, approvalState, showCacheMissNotices } = options;
  return (event) => {
    if (event.type === "user_queued") {
      output(`\n↳ 已排队：${event.text}\n`);
    }
    if (event.type === "text_delta") {
      output(`\n${event.text}\n`);
    }
    if (event.type === "thinking_delta") {
      output(`[思考] ${event.text}\n`);
    }
    if (event.type === "todo_update") {
      output("\n任务清单：\n");
      for (const todo of event.todos) {
        const marker =
          todo.status === "completed"
            ? "✓"
            : todo.status === "in_progress"
              ? "→"
              : "○";
        output(`  ${marker} ${todo.content}\n`);
      }
    }
    if (event.type === "tool_call") {
      output(`\n→ ${event.call.tool}(${event.call.target})\n`);
    }
    if (event.type === "ask_permission") {
      approvalState.pendingCallId = event.call.id;
      output(
        `  需要审批：${event.risk}\n` +
          `  ${event.call.tool}(${event.call.target})\n` +
          `${event.purpose ? `  目的：${event.purpose}\n` : ""}` +
          `${event.detail ? `${event.detail}\n` : ""}` +
          "  输入 y/n；/allow session|project|global 可记住；/deny 可附留言。\n",
      );
    }
    if (event.type === "permission_denied") {
      if (approvalState.pendingCallId === event.call.id) {
        approvalState.pendingCallId = "";
      }
      output(`\n拒绝：${event.reason}\n`);
    }
    if (event.type === "tool_result") {
      output(`  ${event.summary}\n`);
    }
    if (event.type === "cost_update") {
      // 显示门控（参照 Pi cache-stats）：压缩重置属合法信息始终提示；
      // 其余 miss 提示需开启 behavior.showCacheMissNotices 且超过显示阈值
      const hasMiss = Boolean(
        event.missedTokens && event.missedTokens > 0,
      );
      const showMiss =
        hasMiss &&
        (event.missedReason === "compaction" ||
          (showCacheMissNotices &&
            shouldShowCacheMissNotice(
              event.missedTokens,
              event.missedCostCny,
            )));
      const missedLabel = !showMiss
        ? ""
        : event.missedReason === "compaction"
          ? " · 缓存已重置（压缩）"
          : event.missedReason === "model_switch"
            ? ` · 缓存失效 ${event.missedTokens}（模型切换）`
            : event.missedReason === "idle"
              ? ` · 缓存过期 ${event.missedTokens}（空闲超时）`
              : ` · 缓存未命中浪费 ${event.missedTokens}`;
      const missedCostLabel =
        showMiss && event.missedCostCny && event.missedCostCny > 0
          ? `（多花 ¥${event.missedCostCny.toFixed(4)}）`
          : "";
      output(
        `  本轮 ${event.input} in / ${event.output} out` +
          `${event.cached ? ` / ${event.cached} cached` : ""}` +
          ` · 会话累计 ${event.totalTokens}` +
          missedLabel +
          missedCostLabel +
          "\n",
      );
    }
    if (event.type === "context_compacted") {
      output(
        `\n上下文已压缩：保留比例 ${(event.ratio * 100).toFixed(1)}%\n`,
      );
    }
    if (event.type === "task_start") {
      output(`\n◇ 子代理：${event.description}\n`);
    }
    if (event.type === "task_end") {
      output(
        `  子代理 ${event.status} · ${event.toolCalls} 次工具调用 · ` +
          `${event.inputTokens} in / ${event.outputTokens} out\n`,
      );
    }
    if (event.type === "run_started") {
      output(
        `\n◆ 无人值守任务 #${event.taskId} 已启动 · ${event.permissionMode} 档\n`,
      );
    }
    if (event.type === "review_result") {
      const icon = event.passed ? "✓" : "✗";
      const issuesText =
        event.issues.length > 0
          ? `\n` + event.issues.map((issue) => `    - ${issue}`).join("\n")
          : "";
      output(
        `\n${icon} 完成审查${event.passed ? "通过" : `未通过（第 ${event.attempts} 次）`}${issuesText}\n`,
      );
    }
    if (event.type === "ledger_update") {
      // 任务执行账本：每个文件/子任务一行实时增量（状态徽标 + 相对路径）
      const marker =
        event.unit.status === "done"
          ? "✓"
          : event.unit.status === "verified"
            ? "✔"
            : event.unit.status === "in_progress"
              ? "→"
              : event.unit.status === "blocked"
                ? "✗"
                : "○";
      output(`  ${marker} ${event.unit.label}\n`);
    }
    if (event.type === "wrapup_warning") {
      output(`\n⚠ 任务进入 ${event.level} 阶段：${event.message}\n`);
    }
    if (event.type === "run_finished") {
      output(
        `\n◆ 无人值守任务 #${event.taskId} ${event.status}` +
          `${event.reason ? `（${event.reason}）` : ""}，权限档已回落。\n`,
      );
    }
    if (event.type === "model_fallback") {
      output(
        `\n↪ ${event.role} 模型降级：${event.from} → ${event.to}\n` +
          `  原因：${event.reason}\n`,
      );
    }
    if (event.type === "need_user") {
      output(`\n需要你的决定：${event.question}\n`);
    }
    if (event.type === "done") {
      output("\n✓ 本轮任务完成，可继续输入。\n");
    }
    if (event.type === "error") {
      output(`\n运行失败：${event.message}\n`);
    }
    if (event.type === "notify") {
      const icon = event.level === "warn" ? "⚠" : event.level === "error" ? "✗" : "ℹ";
      output(`\n${icon} ${event.message}\n`);
    }
    if (event.type === "interrupted") {
      output(
        "\n任务已中止；文件编辑保持原子性，Bash 已发生的副作用无法自动撤销。\n",
      );
    }
    if (event.type === "branch_switch") {
      output(
        `\n⇄ 已切换到分支 #${event.branchId}` +
          `${event.label ? `（${event.label}）` : ""}\n`,
      );
    }
    if (event.type === "branch_summarized") {
      const preview =
        event.summary.length > 120
          ? `${event.summary.slice(0, 120)}…`
          : event.summary;
      output(
        `\n⇄ 分支摘要（来自 #${event.fromBranchId}，fork@#${event.forkSeq}）：\n  ${preview.replace(/\n/g, "\n  ")}\n`,
      );
    }
  };
}

/** 事件时间线摘要：为 /timeline 提供单行描述（选择 fork 点用） */
export function summarizeEvent(event: AgentEvent): string {
  switch (event.type) {
    case "user":
      return `用户：${event.text.slice(0, 40)}`;
    case "text_delta":
      return `助手：${event.text.slice(0, 40)}`;
    case "tool_call":
      return `工具：${event.call.tool}(${event.call.target})`;
    case "tool_result":
      return `结果：${event.summary.slice(0, 40)}`;
    case "permission_denied":
      return `拒绝：${event.reason.slice(0, 40)}`;
    case "branch_switch":
      return `分支切换：→ #${event.branchId}`;
    case "context_compacted":
      return `上下文压缩：${event.summary.slice(0, 40)}`;
    case "run_started":
      return `无人值守任务：${event.description.slice(0, 40)}`;
    case "ledger_update":
      return `账本：#${event.taskId} ${event.unit.label}（${event.unit.status}）`;
    default:
      return event.type;
  }
}
