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

export interface PluginTool {
  /** 全局唯一工具名（建议 PascalCase；不得与内置工具重名） */
  name: string;
  /** 进系统提示的工具说明（模型据此决定是否调用） */
  description: string;
  /** JSON Schema（与内置工具 inputSchema 同构，参数经统一校验） */
  inputSchema: Record<string, unknown>;
  run(
    args: Record<string, unknown>,
    signal: AbortSignal,
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

export class PluginToolRegistry {
  readonly #tools = new Map<string, PluginTool>();
  /** name → 来源文件（错误信息与同名覆盖诊断用） */
  readonly #sources = new Map<string, string>();

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

  get(name: string): PluginTool | undefined {
    return this.#tools.get(name);
  }

  names(): string[] {
    return [...this.#tools.keys()];
  }

  /** 插件定义转模型可见的 ToolDefinition（注入 tools 数组与 system prompt 工具清单） */
  definitions(): ToolDefinition[] {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /** 按名分发执行；未注册名返回失败结果（不抛，与 execute 兜底语义一致） */
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
    try {
      const result = await tool.run(args ?? {}, signal);
      return {
        summary: result.summary,
        ...(result.output === undefined ? {} : { output: result.output }),
        ...(result.details === undefined ? {} : { details: result.details }),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
      };
    } catch (error) {
      return {
        summary:
          error instanceof Error ? error.message : "插件工具执行发生未知错误",
        isError: true,
      };
    }
  }
}

/** 进程级单例：loader 启动时填充，会话装配与 client 守卫共用同一份注册表 */
export const pluginToolRegistry = new PluginToolRegistry();
