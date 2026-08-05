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
