/** 全部内建工具名（单一事实来源：core/types 的 ToolName 类型、client 的运行时守卫、
    permissions 的工具集划分、统计侧的工具子集均从此派生） */
export const TOOL_NAMES = [
  "Read",
  "Grep",
  "Glob",
  "TodoWrite",
  "Task",
  "Edit",
  "MultiEdit",
  "Write",
  "Bash",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

/** 插件工具只读启发式动词表：工具名按驼峰/分隔符切段后，任一动词段命中即视为只读。
    与权限风险翻译（agent-loop riskFor）和插件并行缺省判定（executor.isParallelSafe）共用。 */
const READONLY_VERBS = new Set([
  "list", "read", "get", "search", "query", "fetch", "lookup", "status",
  "info", "show", "inspect", "view", "describe", "check", "ping", "stat",
  "peek", "head", "tail", "whoami", "print", "echo", "find", "ls", "dir",
  "tree", "schema", "version", "help", "cat",
]);

export function looksReadOnlyToolName(toolName: string): boolean {
  const segments = toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return segments.some((segment) => READONLY_VERBS.has(segment));
}
