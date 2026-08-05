import type { AgentTurnTrace } from "../core/events.js";
import type { ToolName } from "../core/types.js";

export interface SessionTraceStats {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** 缓存命中率（cached/input）；无 usage 时为 null */
  cacheRate: number | null;
  /** Edit/MultiEdit 调用中产生文本 diff 的次数 */
  editCalls: number;
  /** 全部 Edit/MultiEdit diff 字符数（trace 里是未截断的完整输出） */
  diffTotalChars: number;
  /** diff 字符数占输入字符当量（inputTokens × 4）的比例；无输入时为 null */
  diffCharsPerInputChar: number | null;
  bashCalls: number;
  bashTruncated: number;
  bashOutputIncomplete: number;
}

/** 文本 diff 相关工具（结果中 output 为完整 diff，用于占比测量） */
const DIFF_TOOLS: ReadonlySet<string> = new Set<ToolName>([
  "Edit",
  "MultiEdit",
]);

interface TolerantToolResult {
  output?: unknown;
  details?: {
    truncated?: boolean;
    outputIncomplete?: boolean;
  };
}

/** trace 的 result 为 unknown：宽容取出统计所需字段 */
function tolerantResult(result: unknown): TolerantToolResult | undefined {
  if (!result || typeof result !== "object") return undefined;
  const value = result as Record<string, unknown>;
  const details = value.details;
  if (details && typeof details === "object") {
    return { output: value.output, details: details as NonNullable<TolerantToolResult["details"]> };
  }
  return { output: value.output };
}

/**
 * 会话 trace 统计（供测量脚本与后续决策使用）：
 * - diff 占比：Edit/MultiEdit 完整 diff 字符数 vs 输入字符当量，
 *   用于决定"diff 是否应移出 LLM 上下文"（P0-3 观察项）；
 * - bash 截断/不完整率：评估输出上限与排空策略。
 */
export function aggregateTraces(
  traces: AgentTurnTrace[],
): SessionTraceStats {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let editCalls = 0;
  let diffTotalChars = 0;
  let bashCalls = 0;
  let bashTruncated = 0;
  let bashOutputIncomplete = 0;

  for (const trace of traces) {
    inputTokens += trace.usage?.input ?? 0;
    outputTokens += trace.usage?.output ?? 0;
    cachedTokens += trace.usage?.cached ?? 0;
    for (const item of trace.tools) {
      const tool = item.call.tool;
      const result = tolerantResult(item.result);
      if (DIFF_TOOLS.has(tool)) {
        const output = result?.output;
        if (typeof output === "string" && output.length > 0) {
          editCalls += 1;
          diffTotalChars += output.length;
        }
      } else if (tool === "Bash") {
        bashCalls += 1;
        if (result?.details?.truncated) bashTruncated += 1;
        if (result?.details?.outputIncomplete) bashOutputIncomplete += 1;
      }
    }
  }

  return {
    turns: traces.length,
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheRate: inputTokens > 0 ? cachedTokens / inputTokens : null,
    editCalls,
    diffTotalChars,
    diffCharsPerInputChar:
      inputTokens > 0 ? diffTotalChars / (inputTokens * 4) : null,
    bashCalls,
    bashTruncated,
    bashOutputIncomplete,
  };
}
