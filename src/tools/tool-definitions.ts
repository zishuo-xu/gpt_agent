import type { ToolName } from "../core/types.js";
import { pluginToolRegistry } from "../shared/plugin-tool.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 子代理（explore 角色）默认只读工具集：探索定位为主，不注入任何写工具 */
export const EXPLORE_TOOL_NAMES: readonly ToolName[] = [
  "Read",
  "Grep",
  "Glob",
  "TodoWrite",
];

/** 顺序执行的内置工具（P0-1）：并行模式下含任一此类工具的批次整批退化为串行。
    写类工具需互斥（防同批写竞争），Bash 副作用不可并行。 */
export const SEQUENTIAL_TOOL_NAMES: ReadonlySet<ToolName> = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "Bash",
]);

/** 全量工具 = 内置 + 插件注册表（进程启动时由 loader 填充）。
    会话内工具集固定约束与内置工具相同。 */
export function getAllToolDefinitions(): ToolDefinition[] {
  return [
    ...CODING_TOOL_DEFINITIONS,
    ...pluginToolRegistry.definitions(),
  ];
}

/** 按名称解析工具定义；未指定时返回全量（main 角色，含插件工具）。
    调用方必须保证同一模型会话内工具集固定，否则会破坏 prompt cache 前缀。 */
/** 子代理（explore 角色）工具集：只读内置 + 当前已注册的插件工具（热加载后立即可见） */
export function exploreToolNames(): string[] {
  return [...EXPLORE_TOOL_NAMES, ...pluginToolRegistry.names()];
}

export function toolDefinitionsFor(
  names: readonly (ToolName | string)[] | undefined,
): ToolDefinition[] {
  if (!names) return getAllToolDefinitions();
  const byName = new Map(
    getAllToolDefinitions().map((tool) => [tool.name, tool]),
  );
  return names
    .map((name) => byName.get(name))
    .filter((tool): tool is ToolDefinition => tool !== undefined);
}

export const CODING_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "Read",
    description:
      "Read a UTF-8 text file with line numbers. You must call Read before editing an existing file. Use offset and limit to continue large files.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", minLength: 1, description: "Absolute or project-relative path" },
        offset: {
          type: "number",
          description: "One-based first line. Defaults to 1.",
        },
        limit: {
          type: "number",
          description: "Maximum lines. Defaults to 2000.",
        },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "Grep",
    description:
      "Search UTF-8 project files by regular expression. Returns file:line evidence. Use path or glob to narrow broad searches.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", minLength: 1, description: "Regular expression" },
        path: {
          type: "string",
          description: "Project-relative file or directory. Defaults to .",
        },
        glob: {
          type: "string",
          description: "Optional file glob such as **/*.ts",
        },
        max_results: {
          type: "number",
          description: "Maximum matching lines. Defaults to 200.",
        },
        case_insensitive: {
          type: "boolean",
          description: "When true, the search is case-insensitive. Defaults to true.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "Glob",
    description:
      "List project files matching a glob such as src/**/*.ts. Build and dependency directories are skipped.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", minLength: 1 },
        path: {
          type: "string",
          description: "Project-relative directory. Defaults to .",
        },
        max_results: {
          type: "number",
          description: "Maximum paths. Defaults to 500.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "TodoWrite",
    description:
      "Replace the complete task list. Use for tasks with about three or more steps. Keep at most one item in_progress.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["id", "content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
  },
  {
    name: "Task",
    description:
      "Delegate a focused exploration to an isolated sub-agent. Write a self-contained prompt because the sub-agent cannot see the parent conversation. It is read-only unless writable is explicitly true.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          minLength: 1,
          description: "Short task label",
        },
        prompt: {
          type: "string",
          minLength: 1,
          description:
            "Complete standalone instructions, expected evidence, and output format",
        },
        writable: {
          type: "boolean",
          description: "Allow file writes. Defaults to false.",
        },
      },
      required: ["description", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "Edit",
    description:
      "Replace one exact, unique string in a previously read file. Use replace_all only when every occurrence should change.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", minLength: 1 },
        old_string: { type: "string", minLength: 1 },
        new_string: { type: "string", minLength: 1 },
        replace_all: { type: "boolean" },
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "MultiEdit",
    description:
      "Apply multiple exact edits to one previously read file atomically. If any edit fails, none are written.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", minLength: 1 },
        edits: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              old_string: { type: "string", minLength: 1 },
              new_string: { type: "string", minLength: 1 },
              replace_all: { type: "boolean" },
            },
            required: ["old_string", "new_string"],
            additionalProperties: false,
          },
        },
      },
      required: ["file_path", "edits"],
      additionalProperties: false,
    },
  },
  {
    name: "Write",
    description:
      "Create a new UTF-8 text file or replace a previously read file with complete content.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", minLength: 1 },
        content: { type: "string", minLength: 1 },
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "Bash",
    description:
      "Run a shell command in the project directory. Prefer focused read-only commands and project tests. Existing side effects cannot be rolled back when interrupted.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1 },
        timeout_ms: {
          type: "number",
          description: "Optional timeout in milliseconds",
        },
        background: {
          type: "boolean",
          description:
            "Start the command in the background and return immediately without waiting or collecting output",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "BrowserCheck",
    description:
      "Open a URL in a headless browser and return page status: HTTP code, title, console errors, and rendered body text. Use it to verify that a web app actually renders (SPA included) after starting the dev/preview server. Requires the Playwright chromium binary (npx playwright install chromium).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1 },
        timeout_ms: {
          type: "number",
          description: "Optional navigation timeout in milliseconds",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];
