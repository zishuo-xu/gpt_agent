import { spawn } from "node:child_process";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  TodoItem,
  ToolCall,
  ToolExecutionResult,
} from "../core/types.js";
import { escapeRegExp } from "../utils/regexp.js";
import { TodoStore } from "../core/todos.js";
import { AtomicFileTools } from "./atomic-file.js";
import { validateToolArgs } from "./args-validate.js";
import { runBash } from "./bash.js";
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
          summary: `已读取 ${args.file_path} 第 ${offset}-${Math.min(
            offset + limit - 1,
            lines.length,
          )} 行（共 ${lines.length} 行）`,
          output: bounded.text,
          traceOutput: paged,
          details: {
            filePath: args.file_path,
            startLine: offset,
            endLine: Math.min(offset + limit - 1, lines.length),
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
        const files = await collectFiles(root, signal);
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
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

/** 遍历并发度：目录 readdir 有界并发，避免大仓库串行 IO */
const WALK_CONCURRENCY = 16;

/**
 * 收集 root 下的全部文件路径：
 * - git 仓库内用 `git ls-files`（自带 .gitignore 语义，含未跟踪非忽略文件）；
 * - 非 git 目录维持目录遍历，并按根 .gitignore 前缀过滤；
 * - 两路都排除硬编码 IGNORED_DIRECTORIES 与符号链接。
 */
async function collectFiles(
  root: string,
  signal: AbortSignal,
): Promise<string[]> {
  assertNotAborted(signal);
  const info = await stat(root);
  if (info.isFile()) return [root];
  const gitFiles = await listGitFiles(root, signal);
  if (gitFiles) return gitFiles;
  return walkFiles(root, signal, await GitignoreMatcher.load(root));
}

/** git 仓库文件列表；非仓库（或 git 不可用）返回 undefined 走遍历 */
async function listGitFiles(
  root: string,
  signal: AbortSignal,
): Promise<string[] | undefined> {
  const child = spawn(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const onAbort = () => child.kill();
  signal.addEventListener("abort", onAbort, { once: true });
  const code = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", resolve);
  });
  signal.removeEventListener("abort", onAbort);
  if (code !== 0 || stdout === "") return undefined;
  assertNotAborted(signal);
  const files = stdout
    .split("\0")
    .filter(Boolean)
    .map((file) => path.join(root, file))
    .filter(
      (file) =>
        !file.split(path.sep).some((segment) => IGNORED_DIRECTORIES.has(segment)),
    );
  // 过滤目录项（submodule 等）与符号链接，与遍历路径语义一致
  const stats = await Promise.all(
    files.map((file) => lstat(file).catch(() => null)),
  );
  return files.filter((_, index) => stats[index]?.isFile());
}

/** 有界并发 BFS 目录遍历 + gitignore 过滤 */
async function walkFiles(
  root: string,
  signal: AbortSignal,
  ignore: GitignoreMatcher,
): Promise<string[]> {
  const output: string[] = [];
  const queue: string[] = [root];
  let running = 0;
  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      while (running < WALK_CONCURRENCY && queue.length > 0) {
        const directory = queue.shift();
        if (!directory) break;
        assertNotAborted(signal);
        running += 1;
        readdir(directory, { withFileTypes: true }).then(
          (entries) => {
            entries.sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of entries) {
              if (entry.isSymbolicLink()) continue;
              const entryPath = path.join(directory, entry.name);
              if (entry.isDirectory()) {
                if (!IGNORED_DIRECTORIES.has(entry.name) &&
                    !ignore.ignores(entryPath, true)) {
                  queue.push(entryPath);
                }
              } else if (entry.isFile() && !ignore.ignores(entryPath, false)) {
                output.push(entryPath);
              }
            }
            running -= 1;
            pump();
          },
          (error) => {
            running -= 1;
            reject(error);
          },
        );
      }
      if (running === 0 && queue.length === 0) resolve();
    };
    pump();
  });
  output.sort((a, b) => a.localeCompare(b));
  return output;
}

/**
 * 根 .gitignore 前缀过滤（非 git 目录的轻量替代）：
 * - 规则以 `/` 结尾 → 目录前缀：该目录及其子路径全部忽略；
 * - 含 `/` 的规则锚定仓库根（相对路径匹配）；
 * - 不含 `/` 的规则匹配任意层级 basename；
 * - 支持 `*`/`?`/`**` glob；不支持 `!` 否定与嵌套 .gitignore。
 */
class GitignoreMatcher {
  static async load(root: string): Promise<GitignoreMatcher> {
    let content = "";
    try {
      content = await readFile(path.join(root, ".gitignore"), "utf8");
    } catch {
      // 无 .gitignore 视为无规则
    }
    return new GitignoreMatcher(root, content);
  }

  readonly #root: string;
  readonly #dirPrefixes: string[] = [];
  readonly #filePatterns: Array<{
    re: RegExp;
    anchored: boolean;
    prefix?: string;
  }> = [];

  private constructor(root: string, content: string) {
    this.#root = root;
    for (const rawLine of content.split("\n")) {
      const line = rawLine.replace(/\s+$/, "");
      if (line === "" || line.startsWith("#")) continue;
      if (line.startsWith("!")) continue; // 否定规则暂不支持
      if (line.endsWith("/")) {
        this.#dirPrefixes.push(line.slice(0, -1));
        continue;
      }
      const anchored = line.includes("/");
      const hasGlob = /[*?[\]]/.test(line);
      this.#filePatterns.push({
        re: globToRegExp(line),
        anchored,
        // 无 glob 字面的锚定规则按目录前缀处理（如 src/generated）
        ...(anchored && !hasGlob ? { prefix: line } : {}),
      });
    }
  }

  ignores(entryPath: string, isDir: boolean): boolean {
    const relative = normalizeSlashes(path.relative(this.#root, entryPath));
    if (relative === "" || relative.startsWith("../")) return false;
    const basename = relative.split("/").at(-1) ?? relative;
    const pathSegments = relative.split("/");
    // 目录规则匹配的应是路径上的祖先目录段（文件自身不算目录）
    const ancestorSegments = isDir
      ? pathSegments
      : pathSegments.slice(0, -1);
    for (const prefix of this.#dirPrefixes) {
      if (prefix.includes("/")) {
        // 含斜杠的目录规则锚定仓库根
        if (relative.startsWith(`${prefix}/`)) return true;
        if (isDir && relative === prefix) return true;
      } else if (ancestorSegments.includes(prefix)) {
        // 无斜杠的目录规则匹配任意层级
        return true;
      }
    }
    for (const { re, anchored, prefix } of this.#filePatterns) {
      if (anchored) {
        if (re.test(relative)) return true;
        if (prefix && relative.startsWith(`${prefix}/`)) return true;
      } else if (re.test(basename)) {
        return true;
      }
    }
    return false;
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

/** 统计 unified diff 的 hunk 数（@@ 行），用于 Edit/Write 结果的简短描述 */
function diffHunkCount(diff: string): number {
  const matches = diff.match(/^@@/gm);
  return matches?.length ?? 1;
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
