import type { AgentEventBus } from "./events.js";
import type { AgentModel } from "./agent-loop.js";
import type {
  ToolCall,
  ToolExecutionResult,
} from "./types.js";
import type { ToolExecutor } from "../tools/executor.js";

/** 工具追踪记录（回合 trace 的 tools 数组项） */
export interface ToolTraceItem {
  call: ToolCall;
  permission: string;
  result?: unknown;
  ms: number;
}

/** 拒绝侧副作用：permission_denied 事件 + 模型拒绝回灌 + trace 记录 */
export function emitDeniedTool(
  bus: AgentEventBus,
  model: AgentModel,
  traceTools: ToolTraceItem[],
  options: {
    call: ToolCall;
    reason: string;
    permission: string;
    ms: number;
  },
): void {
  bus.emit({
    type: "permission_denied",
    call: options.call,
    reason: options.reason,
  });
  model.acceptToolDenied?.(options.call, options.reason);
  traceTools.push({
    call: options.call,
    permission: options.permission,
    result: { error: options.reason },
    ms: options.ms,
  });
}

/** 结果侧副作用：tool_result 事件（含 todo 快照）+ 模型结果回灌 + trace 记录。
    返回最终结果（P0-3 起供调用方累计 FileOps 等） */
export function emitToolResult(
  bus: AgentEventBus,
  model: AgentModel,
  traceTools: ToolTraceItem[],
  options: {
    call: ToolCall;
    result: ToolExecutionResult;
    permission: string;
    ms: number;
  },
): ToolExecutionResult {
  const { call, result } = options;
  bus.emit({
    type: "tool_result",
    callId: call.id,
    summary: result.summary,
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(result.details === undefined ? {} : { details: result.details }),
    ...(result.aborted === undefined ? {} : { aborted: result.aborted }),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  });
  if (result.todoSnapshot) {
    bus.emit({
      type: "todo_update",
      todos: result.todoSnapshot,
    });
  }
  model.acceptToolResult?.(call, result, result.isError ?? false);
  traceTools.push({
    call,
    permission: options.permission,
    result: {
      ...result,
      output: result.traceOutput ?? result.output,
    },
    ms: options.ms,
  });
  return result;
}

/** 执行 + 结果回灌（异常转为 isError 结果），串行/并行批次共用。
    transform（P0-4 afterToolCall）在 emit 前应用：事件流与模型回灌均反映改写后的结果。
    返回最终结果（P0-3 起供调用方累计 FileOps 等）。 */
export async function executeTool(
  bus: AgentEventBus,
  model: AgentModel,
  tools: ToolExecutor,
  traceTools: ToolTraceItem[],
  options: {
    call: ToolCall;
    permission: string;
    signal: AbortSignal;
    ms: number;
    onData?: (chunk: string) => void;
    transform?: (
      result: ToolExecutionResult,
    ) => ToolExecutionResult | void | Promise<ToolExecutionResult | void>;
  },
): Promise<ToolExecutionResult> {
  try {
    const raw = await tools.execute(options.call, options.signal, {
      ...(options.onData ? { onData: options.onData } : {}),
    });
    const transformed = options.transform
      ? await options.transform(raw)
      : undefined;
    const result = transformed ?? raw;
    return emitToolResult(bus, model, traceTools, {
      call: options.call,
      result,
      permission: options.permission,
      ms: options.ms,
    });
  } catch (error) {
    const raw: ToolExecutionResult = {
      summary:
        error instanceof Error ? error.message : "工具执行发生未知错误",
    };
    const transformed = options.transform
      ? await options.transform({ ...raw, isError: true })
      : undefined;
    const result = transformed ?? { ...raw, isError: true };
    return emitToolResult(bus, model, traceTools, {
      call: options.call,
      result,
      permission: options.permission,
      ms: options.ms,
    });
  }
}
