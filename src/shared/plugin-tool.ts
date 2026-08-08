import type { ToolExecutionResult } from "../core/types.js";
import type { ToolDefinition } from "../tools/tool-definitions.js";
import { isToolName } from "./tool-names.js";

/**
 * 插件工具协议（参照 Pi 扩展系统的 tools 注册面，一期仅"注册 + 执行"）。
 * 插件文件约定：~/.myagent/tools/ 或 <cwd>/.myagent/tools/ 下的单层 *.ts/*.mjs/*.js，
 * 每文件 default 导出一个 PluginTool（建议用 definePluginTool 获得类型提示）。
 *
 * 与内置工具一致的约束：
 * - 会话内工具集固定（插件在进程启动时一次性加载，运行中不刷新，
 *   否则 toolDefinitionsFor 读到的集合变化会破坏 prompt cache 前缀）；
 * - run 不 throw（失败编码进 PluginToolResult.isError，遵循 loop 的 streamFn 契约）；
 * - 工具名不得与内置 TOOL_NAMES 冲突。
 *
 * 权限：插件工具不在 NORMAL_AUTO/STRICT_GATED 划分内——normal 模式兜底 ask
 * （首次调用需审批，可用 "WebFetch(*)" 规则放行），trust 全 allow。
 */

export interface PluginToolResult {
  summary: string;
  /** 进 LLM 上下文的纯文本（与内置工具 output 语义一致） */
  output?: string | Record<string, unknown>;
  /** 仅 UI 展示的结构化详情（不进模型上下文，参照 Pi 工具结果拆分） */
  details?: Record<string, unknown>;
  isError?: boolean;
}

/** 插件声明式配置（可选）：loader 在注册时读取 plugins.json 与环境变量并注入 run 第三参 */
export interface PluginToolConfigDecl {
  /** plugins.json 顶层段名；两层合并后的整段对象注入 run 的 config.section */
  section?: string;
  /** 环境变量注入：环境变量名 → run 接收的参数名 */
  env?: Record<string, string>;
}

/** loader 解析后的运行时配置（run 第三参） */
export interface PluginToolRuntimeConfig {
  /** plugins.json 中声明段的合并值（未配置或段缺失时为 undefined） */
  section?: unknown;
  /** 声明声明的环境变量值（变量未设置时缺省） */
  env?: Record<string, string>;
}

export interface PluginTool {
  /** 全局唯一工具名（建议 PascalCase；不得与内置工具重名） */
  name: string;
  /** 进系统提示的工具说明（模型据此决定是否调用） */
  description: string;
  /** JSON Schema（与内置工具 inputSchema 同构，参数经统一校验） */
  inputSchema: Record<string, unknown>;
  /** 声明式配置（可选）；无需配置的插件可不声明，run 第三参为 undefined */
  config?: PluginToolConfigDecl;
  /** run 超时（毫秒，可选）：超时返回失败结果不抛；缺省 60s（与 MCP 调用超时一致） */
  timeoutMs?: number;
  run(
    args: Record<string, unknown>,
    signal: AbortSignal,
    config?: PluginToolRuntimeConfig,
  ): Promise<PluginToolResult>;
}

/** 类型提示辅助：插件文件 default 导出时获得 PluginTool 形状校验 */
export function definePluginTool(tool: PluginTool): PluginTool {
  return tool;
}

/** 工具名合法性：字母开头，仅字母/数字/下划线/连字符（与模型工具名协议一致） */
export function isValidPluginToolName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(name);
}

/** 插件调用统计（按工具聚合，MCP 工具同样计入） */
export interface PluginCallStats {
  name: string;
  calls: number;
  /** isError 结果数（run 抛错、返回 isError 与超时均计入） */
  errors: number;
  /** 累计耗时（ms） */
  totalMs: number;
}

/** 插件 run 超时默认值：60s（与 MCP 客户端调用超时一致） */
export const DEFAULT_PLUGIN_TIMEOUT_MS = 60_000;

/** run 超时错误（内部标记，execute 捕获后转失败结果，不向调用方抛出） */
export class PluginTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`插件“${name}”执行超时（${timeoutMs}ms）`);
    this.name = "PluginTimeoutError";
  }
}

export class PluginToolRegistry {
  readonly #tools = new Map<string, PluginTool>();
  /** name → 来源文件（错误信息与同名覆盖诊断用） */
  readonly #sources = new Map<string, string>();
  /** name → 调用统计（execute 分发时累计，供可观测性面板展示） */
  readonly #stats = new Map<
    string,
    { calls: number; errors: number; totalMs: number }
  >();
  /** 运行时禁用的工具名（面板开关，内存态；重启/reload 后按配置恢复） */
  readonly #disabled = new Set<string>();

  clear(): void {
    this.#tools.clear();
    this.#sources.clear();
  }

  /**
   * 注册插件工具；同名覆盖（loader 保证项目层后注册以覆盖全局层）。
   * 非法名或与内置工具重名时抛错，由 loader 捕获记入错误清单。
   */
  register(tool: PluginTool, source?: string): void {
    if (!tool || typeof tool.name !== "string" || !isValidPluginToolName(tool.name)) {
      throw new Error(
        source
          ? `插件工具名非法（需字母开头，仅字母/数字/_/-）：${String(tool?.name)}`
          : `插件缺少合法工具名：${String(tool?.name)}`,
      );
    }
    if (isToolName(tool.name)) {
      throw new Error(`插件工具名与内置工具冲突：${tool.name}`);
    }
    if (
      typeof tool.description !== "string" ||
      tool.description.length === 0 ||
      typeof tool.run !== "function"
    ) {
      throw new Error(`插件“${tool.name}”缺少 description 或 run 实现`);
    }
    this.#tools.set(tool.name, tool);
    this.#sources.set(tool.name, source ?? "");
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /** 运行时启用/禁用（内存态；disabled 工具对模型不可见、不可执行） */
  setEnabled(name: string, enabled: boolean): boolean {
    if (!this.#tools.has(name)) return false;
    if (enabled) this.#disabled.delete(name);
    else this.#disabled.add(name);
    return true;
  }

  isEnabled(name: string): boolean {
    return !this.#disabled.has(name);
  }

  get(name: string): PluginTool | undefined {
    return this.#tools.get(name);
  }

  names(): string[] {
    return [...this.#tools.keys()];
  }

  /** 插件定义转模型可见的 ToolDefinition（注入 tools 数组与 system prompt 工具清单） */
  definitions(): ToolDefinition[] {
    return [...this.#tools.values()]
      .filter((tool) => !this.#disabled.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
  }

  /** 按名分发执行；未注册名或已禁用工具返回失败结果（不抛，与 execute 兜底语义一致） */
  async execute(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const tool = this.#tools.get(name);
    if (!tool) {
      return {
        summary: `未知工具：${name}`,
        output: `未注册的工具“${name}”（内置工具见 TOOL_NAMES，插件见 ~/.myagent/tools/）`,
        isError: true,
      };
    }
    if (this.#disabled.has(name)) {
      return {
        summary: `工具已禁用：${name}`,
        output: `插件“${name}”已在插件面板中禁用，启用后重试`,
        isError: true,
      };
    }
    // 超时护栏：挂起的 run 不卡死 agent 循环（超时转失败结果；插件可声明
    // timeoutMs 覆盖，缺省 60s，与 MCP 调用超时一致）
    const timeoutMs = tool.timeoutMs ?? DEFAULT_PLUGIN_TIMEOUT_MS;
    const startedAt = performance.now();
    let isError = false;
    try {
      const result = await withRunTimeout(
        tool.run(args ?? {}, signal),
        name,
        timeoutMs,
      );
      isError = result.isError === true;
      return {
        summary: result.summary,
        ...(result.output === undefined ? {} : { output: result.output }),
        ...(result.details === undefined ? {} : { details: result.details }),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
      };
    } catch (error) {
      isError = true;
      return {
        summary:
          error instanceof PluginTimeoutError
            ? error.message
            : error instanceof Error
              ? error.message
              : "插件工具执行发生未知错误",
        ...(error instanceof PluginTimeoutError
          ? { output: "run 未在限时内返回；可检查插件实现（外部请求挂起、死循环）或调大 timeoutMs" }
          : {}),
        isError: true,
      };
    } finally {
      this.#record(name, isError, performance.now() - startedAt);
    }
  }

  /** 调用统计（按工具聚合；无调用记录的工具不出现） */
  stats(): PluginCallStats[] {
    return [...this.#stats.entries()].map(([name, entry]) => ({
      name,
      calls: entry.calls,
      errors: entry.errors,
      totalMs: Math.round(entry.totalMs),
    }));
  }

  #record(name: string, isError: boolean, durationMs: number): void {
    const entry = this.#stats.get(name) ?? {
      calls: 0,
      errors: 0,
      totalMs: 0,
    };
    entry.calls += 1;
    entry.totalMs += durationMs;
    if (isError) entry.errors += 1;
    this.#stats.set(name, entry);
  }
}

/** 进程级单例：loader 启动时填充，会话装配与 client 守卫共用同一份注册表 */
export const pluginToolRegistry = new PluginToolRegistry();

/**
 * run 超时包装：限时内 settle 原样透传；超时 reject PluginTimeoutError。
 * 超时后底层 run 仍可能继续（无法强制取消），其后续 settle 被静默忽略——
 * 已挂上 rejection handler，不会产生 unhandled rejection。
 */
function withRunTimeout<T>(
  promise: Promise<T>,
  name: string,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PluginTimeoutError(name, timeoutMs));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
    // 超时路径：底层 promise 后续 settle 已被上面 handler 消费，无泄漏
  });
}
