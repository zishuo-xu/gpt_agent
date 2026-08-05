import { spawn } from "node:child_process";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { abortError } from "../utils/sleep.js";
import { globToRegExp, normalizeSlashes } from "../utils/glob.js";

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/**
 * 统一忽略目录（git ls-files 与目录遍历共用）。
 * 合并了原 executor 与 RepoMap 两份清单：agent 自身状态（.myagent）与常见构建产物。
 */
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".myagent",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "venv",
]);

/** 目录 readdir 有界并发，避免大仓库串行 IO */
const WALK_CONCURRENCY = 16;

export interface CollectFilesOptions {
  signal?: AbortSignal;
  /** 目录遍历的最大深度（git ls-files 路径不受限——仓库文件清单本身已完整） */
  maxDepth?: number;
}

/**
 * 收集 root 下的全部文件路径（Grep/Glob 与 RepoMap 共用）：
 * - git 仓库内用 `git ls-files`（自带 .gitignore 语义，含未跟踪非忽略文件）；
 * - 非 git 目录维持目录遍历，并按根 .gitignore 前缀过滤；
 * - 两路都排除 IGNORED_DIRECTORIES 与符号链接。
 */
export async function collectFiles(
  root: string,
  options: CollectFilesOptions = {},
): Promise<string[]> {
  const { signal, maxDepth } = options;
  assertNotAborted(signal);
  const info = await stat(root);
  if (info.isFile()) return [root];
  const gitFiles = await listGitFiles(root, signal);
  if (gitFiles) return gitFiles;
  return walkFiles(root, signal, await GitignoreMatcher.load(root), maxDepth);
}

/** git 仓库文件列表；非仓库（或 git 不可用）返回 undefined 走遍历 */
async function listGitFiles(
  root: string,
  signal: AbortSignal | undefined,
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
  signal?.addEventListener("abort", onAbort, { once: true });
  const code = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", resolve);
  });
  signal?.removeEventListener("abort", onAbort);
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
  signal: AbortSignal | undefined,
  ignore: GitignoreMatcher,
  maxDepth: number | undefined,
): Promise<string[]> {
  const output: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  let running = 0;
  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      while (running < WALK_CONCURRENCY && queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        assertNotAborted(signal);
        running += 1;
        const { dir, depth } = item;
        readdir(dir, { withFileTypes: true }).then(
          (entries) => {
            entries.sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of entries) {
              if (entry.isSymbolicLink()) continue;
              const entryPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                if (
                  !IGNORED_DIRECTORIES.has(entry.name) &&
                  !ignore.ignores(entryPath, true) &&
                  (maxDepth === undefined || depth + 1 < maxDepth)
                ) {
                  queue.push({ dir: entryPath, depth: depth + 1 });
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
