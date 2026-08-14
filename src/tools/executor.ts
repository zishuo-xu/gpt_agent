import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  TodoItem,
  ToolCall,
  ToolExecutionResult,
} from "../core/types.js";
import { escapeRegExp } from "../utils/regexp.js";
import { globToRegExp, normalizeSlashes } from "../utils/glob.js";
import { TodoStore } from "../core/todos.js";
import { AtomicFileTools } from "./atomic-file.js";
import { validateToolArgs } from "./args-validate.js";
import { collectFiles } from "./collect-files.js";
import { runBash } from "./bash.js";
import {
  pluginToolRegistry,
  type PluginToolRegistry,
} from "../shared/plugin-tool.js";
import {
  isToolName,
  looksReadOnlyToolName,
} from "../shared/tool-names.js";
import { SEQUENTIAL_TOOL_NAMES } from "./tool-definitions.js";
import { TOOL_OUTPUT_LIMITS, truncateToolText } from "./truncate.js";

interface ReadArgs {
  file_path: string;
  offset?: number;
  limit?: number;
}

interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  max_results?: number;
  case_insensitive?: boolean;
}

interface GlobArgs {
  pattern: string;
  path?: string;
  max_results?: number;
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
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface MultiEditArgs {
  file_path: string;
  edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>;
}

interface WriteArgs {
  file_path: string;
  content: string;
}

interface BashArgs {
  command: string;
  timeout_ms?: number;
  background?: boolean;
}

export class ToolExecutor {
  readonly files: AtomicFileTools;
  readonly todos: TodoStore;
  readonly #cwd: string;
  readonly #taskHandler: TaskHandler | undefined;
  readonly #plugins: PluginToolRegistry;
  /**
   * 文件实际写入监听（任务执行账本用）：Edit/MultiEdit/Write 成功后回调
   * **解析后的绝对路径**。由会话层在 /run 任务期注入、任务结束清除；
   * 未注入时零行为变化。回调抛错不得影响工具结果（记账失败仅记录，不阻断执行）。
   */
  #fileWrittenListener:
    | ((filePath: string) => void | Promise<void>)
    | undefined;

  constructor(
    cwd: string,
    files = new AtomicFileTools(),
    todos = new TodoStore(),
    taskHandler?: TaskHandler,
    plugins: PluginToolRegistry = pluginToolRegistry,
  ) {
    this.#cwd = cwd;
    this.files = files;
    this.todos = todos;
    this.#taskHandler = taskHandler;
    this.#plugins = plugins;
  }

  /** 设置/清除文件写入监听（任务级，由会话层管理生命周期） */
  setFileWrittenListener(
    listener: ((filePath: string) => void | Promise<void>) | undefined,
  ): void {
    this.#fileWrittenListener = listener;
  }

  /** 工具是否可并行执行（P0-1）：内置查顺序集；插件查声明，缺省按只读名启发式
      （保守：非只读名视为顺序，避免未知插件写操作混入并行批次） */
  isParallelSafe(tool: string): boolean {
    if (isToolName(tool)) return !SEQUENTIAL_TOOL_NAMES.has(tool);
    const plugin = this.#plugins.get(tool);
    if (plugin?.executionMode === "parallel") return true;
    if (plugin?.executionMode === "sequential") return false;
    return looksReadOnlyToolName(tool);
  }

  async execute(
    call: ToolCall,
    signal: AbortSignal,
    options?: { onData?: (chunk: string) => void },
  ): Promise<ToolExecutionResult> {
    const onData = options?.onData;
    // schema 单层校验（参照 Pi：TypeBox/JSON Schema 校验 + 类型强转 + 字段级报错，
    // 非空规则已用 minLength/minItems 表达在 schema 中）
    const schemaCheck = validateToolArgs(call);
    if (schemaCheck.error) {
      return { summary: schemaCheck.error, isError: true };
    }
    const effectiveArgs = schemaCheck.args ?? call.args;
    switch (call.tool) {
      case "Read": {
        const args = effectiveArgs as ReadArgs;
        const filePath = this.#resolve(args.file_path);
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
        const endLine = Math.min(offset + limit - 1, lines.length);
        // 截断提示带精确行号区间：已读区间 + 下一段区间（对齐 Pi 续读指引）
        const nextEndLine =
          nextOffset === undefined
            ? undefined
            : Math.min(nextOffset + limit - 1, lines.length);
        const paged =
          nextOffset === undefined || nextEndLine === undefined
            ? selected
            : `${selected}\n[... 已读第 ${offset}-${endLine} 行，剩余内容已省略；继续读第 ${nextOffset}-${nextEndLine} 行，使用 Read offset=${nextOffset} limit=${limit} 继续 ...]`;
        const bounded = truncateToolText(paged, {
          ...TOOL_OUTPUT_LIMITS.read,
          ...(nextOffset === undefined || nextEndLine === undefined
            ? {}
            : {
                continuationHint: `use Read offset=${nextOffset} limit=${limit} to read lines ${nextOffset}-${nextEndLine}`,
              }),
        });
        return {
          summary: `已读取 ${args.file_path} 第 ${offset}-${endLine} 行（共 ${lines.length} 行）`,
          output: bounded.text,
          traceOutput: paged,
          details: {
            filePath: args.file_path,
            startLine: offset,
            endLine,
            totalLines: lines.length,
            truncated: bounded.truncated,
            ...(nextOffset === undefined ? {} : { nextOffset }),
          },
        };
      }
      case "Grep": {
        const args = effectiveArgs as GrepArgs;
        const root = this.#resolve(args.path ?? ".");
        const maxResults = clampInteger(args.max_results, 1, 2000, 200);
        const caseInsensitive = args.case_insensitive ?? true;
        const matcher = compilePattern(args.pattern, caseInsensitive);
        const globMatcher = args.glob
          ? globToRegExp(normalizeSlashes(args.glob))
          : undefined;
        const files = await collectFiles(root, { signal });
        const matches: string[] = [];
        const matchedFiles = new Set<string>();
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
            matchedFiles.add(relative);
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
          details: {
            pattern: args.pattern,
            matches: matches.length,
            files: matchedFiles.size,
            capped: matches.length >= maxResults,
          },
        };
      }
      case "Glob": {
        const args = effectiveArgs as GlobArgs;
        const root = this.#resolve(args.path ?? ".");
        const maxResults = clampInteger(args.max_results, 1, 5000, 500);
        const matcher = globToRegExp(normalizeSlashes(args.pattern));
        const files = await collectFiles(root, { signal });
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
          details: {
            pattern: args.pattern,
            matches: matches.length,
            capped: matches.length >= maxResults,
          },
        };
      }
      case "TodoWrite": {
        const args = effectiveArgs as TodoWriteArgs;
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
        const args = effectiveArgs as EditArgs;
        const diff = await this.files.edit(
          this.#resolve(args.file_path),
          args.old_string,
          args.new_string,
          args.replace_all,
          signal,
        );
        await this.#notifyFileWritten(this.#resolve(args.file_path));
        // diff 移出 LLM 上下文（Pi：content 只报"替换 N 处"，diff 进 details 供 UI）
        return {
          summary: `已编辑 ${args.file_path}`,
          output: `已编辑 ${args.file_path}（${diffHunkCount(diff)} 处变更）`,
          details: {
            filePath: args.file_path,
            diff,
          },
        };
      }
      case "MultiEdit": {
        const args = effectiveArgs as MultiEditArgs;
        const diff = await this.files.multiEdit(
          this.#resolve(args.file_path),
          args.edits,
          signal,
        );
        await this.#notifyFileWritten(this.#resolve(args.file_path));
        return {
          summary: `已完成 ${args.file_path} 的 ${args.edits.length} 项编辑`,
          output: `已完成 ${args.file_path} 的 ${args.edits.length} 项编辑`,
          details: {
            filePath: args.file_path,
            edits: args.edits.length,
            diff,
          },
        };
      }
      case "Write": {
        const args = effectiveArgs as WriteArgs;
        await this.files.write(
          this.#resolve(args.file_path),
          args.content,
          signal,
        );
        await this.#notifyFileWritten(this.#resolve(args.file_path));
        // 参照 Pi write.ts：Write 不带 diff（模型知道写入内容），只报字节数；
        // 大文件不产生 details.diff，避免事件流持久化膨胀
        return {
          summary: `已写入 ${args.file_path}`,
          output: `已写入 ${args.file_path}（${Buffer.byteLength(args.content)} 字节）`,
          details: {
            filePath: args.file_path,
          },
        };
      }
      case "Bash": {
        const args = effectiveArgs as BashArgs;
        return await runBash(args.command, {
          cwd: this.#cwd,
          timeoutMs: args.timeout_ms ?? 120_000,
          signal,
          ...(args.background ? { background: true } : {}),
          ...(onData
            ? { onData }
            : {}),
        });
      }
      default: {
        // 插件通道：注册表分发（未知名返回失败结果，不抛）
        return await this.#plugins.execute(
          call.tool,
          (effectiveArgs ?? {}) as Record<string, unknown>,
          signal,
        );
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
        this.#resolve(args.file_path),
        args.old_string,
        args.new_string,
        args.replace_all,
      );
    }
    if (call.tool === "MultiEdit") {
      const args = call.args as MultiEditArgs;
      return await this.files.previewMultiEdit(
        this.#resolve(args.file_path),
        args.edits,
      );
    }
    if (call.tool === "Write") {
      const args = call.args as WriteArgs;
      return await this.files.previewWrite(
        this.#resolve(args.file_path),
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

  /** 文件写入成功后通知监听（错误隔离：记账失败不影响工具结果与主循环） */
  async #notifyFileWritten(filePath: string): Promise<void> {
    const listener = this.#fileWrittenListener;
    if (!listener) return;
    try {
      await listener(filePath);
    } catch {
      // 记账失败静默：执行账本是可观测性增强，不阻断编码主流程
    }
  }
}


function compilePattern(pattern: string, caseInsensitive = true): RegExp {
  const flag = caseInsensitive ? "i" : "";
  try {
    return new RegExp(pattern, flag);
  } catch {
    return new RegExp(escapeRegExp(pattern), flag);
  }
}

/** 统计 unified diff 的 hunk 数（@@ 行），用于 Edit/Write 结果的简短描述 */
function diffHunkCount(diff: string): number {
  const matches = diff.match(/^@@/gm);
  return matches?.length ?? 1;
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
