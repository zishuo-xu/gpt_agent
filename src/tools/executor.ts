import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  TodoItem,
  ToolCall,
  ToolExecutionResult,
} from "../core/types.js";
import { TodoStore } from "../core/todos.js";
import { AtomicFileTools } from "./atomic-file.js";
import { runBash } from "./bash.js";
import { TOOL_OUTPUT_LIMITS, truncateToolText } from "./truncate.js";

interface ReadArgs {
  filePath: string;
  offset?: number;
  limit?: number;
}

interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  maxResults?: number;
  caseInsensitive?: boolean;
}

interface GlobArgs {
  pattern: string;
  path?: string;
  maxResults?: number;
}

interface TodoWriteArgs {
  todos: TodoItem[];
}

export interface TaskArgs {
  description: string;
  prompt: string;
  writable?: boolean;
}

export type TaskHandler = (
  args: TaskArgs,
  signal: AbortSignal,
) => Promise<ToolExecutionResult>;

interface EditArgs {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

interface MultiEditArgs {
  filePath: string;
  edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }>;
}

interface WriteArgs {
  filePath: string;
  content: string;
}

interface BashArgs {
  command: string;
  timeoutMs?: number;
  background?: boolean;
}

export class ToolExecutor {
  readonly files: AtomicFileTools;
  readonly todos: TodoStore;
  readonly #cwd: string;
  readonly #taskHandler: TaskHandler | undefined;

  constructor(
    cwd: string,
    files = new AtomicFileTools(),
    todos = new TodoStore(),
    taskHandler?: TaskHandler,
  ) {
    this.#cwd = cwd;
    this.files = files;
    this.todos = todos;
    this.#taskHandler = taskHandler;
  }

  async execute(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const validationError = validateArgs(call);
    if (validationError) {
      return { summary: validationError, isError: true };
    }
    switch (call.tool) {
      case "Read": {
        const args = call.args as ReadArgs;
        const filePath = this.#resolve(args.filePath);
        const content = await this.files.read(filePath, signal);
        const lines = content.split(/\r?\n/);
        const offset = clampInteger(args.offset, 1, lines.length || 1, 1);
        const limit = clampInteger(args.limit, 1, 2000, 2000);
        const selected = lines
          .slice(offset - 1, offset - 1 + limit)
          .map(
            (line, index) =>
              `${offset + index}\t${truncateLine(line, 2000)}`,
          )
          .join("\n");
        const nextOffset = offset - 1 + limit < lines.length
          ? offset + limit
          : undefined;
        const paged =
          nextOffset === undefined
            ? selected
            : `${selected}\n[... 其余内容已省略，使用 Read offset=${nextOffset} 继续 ...]`;
        const bounded = truncateToolText(paged, {
          ...TOOL_OUTPUT_LIMITS.read,
          continuationHint: `use Read offset=${Math.max(
            offset + 1,
            offset + Math.floor(limit * 0.6),
          )} to continue`,
        });
        return {
          summary: `已读取 ${args.filePath} 第 ${offset}-${Math.min(
            offset + limit - 1,
            lines.length,
          )} 行（共 ${lines.length} 行）`,
          output: bounded.text,
          traceOutput: paged,
        };
      }
      case "Grep": {
        const args = call.args as GrepArgs;
        const root = this.#resolve(args.path ?? ".");
        const maxResults = clampInteger(args.maxResults, 1, 2000, 200);
        const caseInsensitive = args.caseInsensitive ?? true;
        const matcher = compilePattern(args.pattern, caseInsensitive);
        const globMatcher = args.glob
          ? globToRegExp(normalizeSlashes(args.glob))
          : undefined;
        const files = await collectFiles(root, signal);
        const matches: string[] = [];
        for (const filePath of files) {
          assertNotAborted(signal);
          const relative = normalizeSlashes(path.relative(this.#cwd, filePath));
          if (globMatcher && !globMatcher.test(relative)) continue;
          const content = await readFile(filePath, "utf8").catch(() => "");
          if (!content || content.includes("\u0000")) continue;
          const lines = content.split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            matcher.lastIndex = 0;
            if (!matcher.test(lines[index] ?? "")) continue;
            matches.push(
              `${relative}:${index + 1}:${truncateLine(lines[index] ?? "", 2000)}`,
            );
            if (matches.length >= maxResults) break;
          }
          if (matches.length >= maxResults) break;
        }
        const grepOutput =
          matches.length === 0
            ? "未找到匹配项"
            : `${matches.join("\n")}${
                matches.length >= maxResults
                  ? `\n[... 已达到 ${maxResults} 条上限，请缩小 path/glob 或提高 max_results ...]`
                  : ""
              }`;
        return {
          summary: `Grep “${args.pattern}”找到 ${matches.length} 条结果`,
          output: truncateToolText(grepOutput, {
            ...TOOL_OUTPUT_LIMITS.grep,
            continuationHint: "narrow path/glob and call Grep again",
          }).text,
          traceOutput: grepOutput,
        };
      }
      case "Glob": {
        const args = call.args as GlobArgs;
        const root = this.#resolve(args.path ?? ".");
        const maxResults = clampInteger(args.maxResults, 1, 5000, 500);
        const matcher = globToRegExp(normalizeSlashes(args.pattern));
        const files = await collectFiles(root, signal);
        const matches = files
          .map((filePath) => normalizeSlashes(path.relative(this.#cwd, filePath)))
          .filter((filePath) => matcher.test(filePath))
          .slice(0, maxResults);
        const globOutput =
          matches.length === 0
            ? "未找到匹配文件"
            : `${matches.join("\n")}${
                matches.length >= maxResults
                  ? `\n[... 已达到 ${maxResults} 条上限，请缩小 pattern/path ...]`
                  : ""
              }`;
        return {
          summary: `Glob “${args.pattern}”找到 ${matches.length} 个文件`,
          output: truncateToolText(globOutput, {
            ...TOOL_OUTPUT_LIMITS.glob,
            continuationHint: "narrow pattern/path and call Glob again",
          }).text,
          traceOutput: globOutput,
        };
      }
      case "TodoWrite": {
        const args = call.args as TodoWriteArgs;
        const snapshot = this.todos.replace(args.todos);
        return {
          summary: `已更新任务清单（${snapshot.filter((item) => item.status === "completed").length}/${snapshot.length} 完成）`,
          output: snapshot,
          todoSnapshot: snapshot,
        };
      }
      case "Task": {
        if (!this.#taskHandler) {
          throw new Error("当前运行时未配置 TaskRunner");
        }
        return await this.#taskHandler(
          call.args as TaskArgs,
          signal,
        );
      }
      case "Edit": {
        const args = call.args as EditArgs;
        const diff = await this.files.edit(
          this.#resolve(args.filePath),
          args.oldString,
          args.newString,
          args.replaceAll,
          signal,
        );
        return { summary: `已编辑 ${args.filePath}`, output: diff };
      }
      case "MultiEdit": {
        const args = call.args as MultiEditArgs;
        const diff = await this.files.multiEdit(
          this.#resolve(args.filePath),
          args.edits,
          signal,
        );
        return {
          summary: `已完成 ${args.filePath} 的 ${args.edits.length} 项编辑`,
          output: diff,
        };
      }
      case "Write": {
        const args = call.args as WriteArgs;
        const diff = await this.files.write(
          this.#resolve(args.filePath),
          args.content,
          signal,
        );
        return { summary: `已写入 ${args.filePath}`, output: diff };
      }
      case "Bash": {
        const args = call.args as BashArgs;
        return await runBash(args.command, {
          cwd: this.#cwd,
          timeoutMs: args.timeoutMs ?? 120_000,
          signal,
          ...(args.background ? { background: true } : {}),
        });
      }
    }
  }

  async preview(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<string> {
    assertNotAborted(signal);
    if (call.tool === "Edit") {
      const args = call.args as EditArgs;
      return await this.files.previewEdit(
        this.#resolve(args.filePath),
        args.oldString,
        args.newString,
        args.replaceAll,
      );
    }
    if (call.tool === "MultiEdit") {
      const args = call.args as MultiEditArgs;
      return await this.files.previewMultiEdit(
        this.#resolve(args.filePath),
        args.edits,
      );
    }
    if (call.tool === "Write") {
      const args = call.args as WriteArgs;
      return await this.files.previewWrite(
        this.#resolve(args.filePath),
        args.content,
      );
    }
    if (call.tool === "Bash") {
      const args = call.args as BashArgs;
      return [
        args.command,
        call.purpose ? `目的：${call.purpose}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  #resolve(filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.join(this.#cwd, filePath);
  }
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

async function collectFiles(
  root: string,
  signal: AbortSignal,
): Promise<string[]> {
  assertNotAborted(signal);
  const info = await stat(root);
  if (info.isFile()) return [root];
  const output: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    assertNotAborted(signal);
    const directory = queue.shift();
    if (!directory) break;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) queue.push(entryPath);
      } else if (entry.isFile()) {
        output.push(entryPath);
      }
    }
  }
  return output;
}

function validateArgs(call: ToolCall): string | undefined {
  const args = call.args;
  if (call.tool === "Read" || call.tool === "Edit" || call.tool === "MultiEdit" || call.tool === "Write") {
    const filePath = (args as { filePath?: unknown }).filePath;
    if (typeof filePath !== "string" || filePath.trim() === "") {
      // 报错文案使用 schema 的 wire 键名，避免模型从错误反馈中学到 camelCase
      return `参数错误：${call.tool} 需要非空的 file_path 参数。请提供要操作的文件路径，例如 "src/index.ts"。`;
    }
  }
  if (call.tool === "Edit" || call.tool === "MultiEdit") {
    if (call.tool === "Edit") {
      const { oldString, newString } = args as { oldString?: unknown; newString?: unknown };
      if (typeof oldString !== "string" || oldString === "") {
        return "参数错误：Edit 需要非空的 old_string 参数（要被替换的原文本）。";
      }
      if (typeof newString !== "string") {
        return "参数错误：Edit 需要 new_string 参数（替换后的文本）。";
      }
    }
    if (call.tool === "MultiEdit") {
      const edits = (args as { edits?: unknown }).edits;
      if (!Array.isArray(edits) || edits.length === 0) {
        return "参数错误：MultiEdit 需要非空的 edits 数组。";
      }
    }
  }
  if (call.tool === "Write") {
    const content = (args as { content?: unknown }).content;
    if (typeof content !== "string") {
      return "参数错误：Write 需要 content 参数（文件内容）。";
    }
  }
  if (call.tool === "Bash") {
    const command = (args as { command?: unknown }).command;
    if (typeof command !== "string" || command.trim() === "") {
      return "参数错误：Bash 需要非空的 command 参数。";
    }
  }
  if (call.tool === "Grep") {
    const pattern = (args as { pattern?: unknown }).pattern;
    if (typeof pattern !== "string" || pattern === "") {
      return "参数错误：Grep 需要非空的 pattern 参数（搜索正则表达式）。";
    }
  }
  if (call.tool === "Glob") {
    const pattern = (args as { pattern?: unknown }).pattern;
    if (typeof pattern !== "string" || pattern === "") {
      return "参数错误：Glob 需要非空的 pattern 参数（文件匹配模式）。";
    }
  }
  return undefined;
}

function compilePattern(pattern: string, caseInsensitive = true): RegExp {
  const flag = caseInsensitive ? "i" : "";
  try {
    return new RegExp(pattern, flag);
  } catch {
    return new RegExp(escapeRegExp(pattern), flag);
  }
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (
      character === "*" &&
      pattern[index + 1] === "*" &&
      pattern[index + 2] === "/"
    ) {
      source += "(?:.*/)?";
      index += 2;
    } else if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(character ?? "");
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function normalizeSlashes(value: string): string {
  return value.split(path.sep).join("/");
}

function truncateLine(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}[… 单行已截断 …]`;
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value as number)));
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
}
