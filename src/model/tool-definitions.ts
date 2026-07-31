export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const CODING_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "Read",
    description:
      "Read a UTF-8 text file with line numbers. You must call Read before editing an existing file. Use offset and limit to continue large files.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute or project-relative path" },
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
        pattern: { type: "string", description: "Regular expression" },
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
        pattern: { type: "string" },
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
          description: "Short task label",
        },
        prompt: {
          type: "string",
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
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
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
        file_path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string" },
              new_string: { type: "string" },
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
        file_path: { type: "string" },
        content: { type: "string" },
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
        command: { type: "string" },
        timeout_ms: {
          type: "number",
          description: "Optional timeout in milliseconds",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
];
