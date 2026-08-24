import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  copyFile,
  lstat,
  mkdir,
  rm,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface ExperimentWorkspaceSnapshot {
  worktreePath: string;
  /** Use this directory as the Agent execution cwd. */
  cwd: string;
  gitRoot: string;
  head: string;
  untrackedCopied: string[];
  warnings: string[];
}

export interface ExperimentWorkspaceManagerOptions {
  experimentsRoot: string;
  /** Injectable command runner for deterministic failure tests. */
  runGit?: (args: string[], options?: { cwd?: string }) => Promise<Buffer | string>;
}

type GitRunner = NonNullable<ExperimentWorkspaceManagerOptions["runGit"]>;

/** Creates and removes disposable, source-project-isolated Git worktrees. */
export class ExperimentWorkspaceManager {
  readonly #experimentsRoot: string;
  readonly #runGit: GitRunner;

  constructor(options: ExperimentWorkspaceManagerOptions) {
    this.#experimentsRoot = path.resolve(options.experimentsRoot);
    this.#runGit = options.runGit ?? defaultGitRunner;
  }

  async createSnapshot(sessionId: string, sourceCwd: string): Promise<ExperimentWorkspaceSnapshot> {
    const source = await realpath(sourceCwd);
    const { gitRoot, head } = await this.#gitInfo(source);
    const relativeCwd = path.relative(gitRoot, source);
    if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
      throw new Error("工作目录不在 Git 根目录内");
    }
    const sessionRoot = path.join(this.#experimentsRoot, sessionId);
    const worktreePath = path.join(sessionRoot, "worktree");
    await mkdir(sessionRoot, { recursive: true });
    const managedRoot = await realpath(path.dirname(this.#experimentsRoot))
      .then((parent) => path.join(parent, path.basename(this.#experimentsRoot)))
      .catch(() => this.#experimentsRoot);
    let worktreeAdded = false;
    try {
      await this.#runGit(["-C", gitRoot, "worktree", "add", "--detach", worktreePath, head]);
      worktreeAdded = true;
      const diff = await this.#runGit(["-C", gitRoot, "diff", "--binary", "HEAD"]);
      if (Buffer.from(diff).length > 0) {
        const patchPath = path.join(sessionRoot, ".snapshot.patch");
        await writeFile(patchPath, Buffer.from(diff));
        await this.#runGit(["-C", worktreePath, "apply", "--binary", "--whitespace=nowarn", patchPath]);
        await rm(patchPath, { force: true });
      }
      const untrackedRaw = Buffer.from(await this.#runGit(["-C", gitRoot, "ls-files", "--others", "--exclude-standard", "-z"]));
      const untrackedCopied: string[] = [];
      let skippedSymlinks = 0;
      let skippedDependencies = 0;
      for (const relative of splitNull(untrackedRaw)) {
        // The managed root may intentionally live inside the repository in
        // tests or local setups; never copy our own snapshot back into itself.
        const absolute = path.resolve(gitRoot, relative);
        if (absolute === managedRoot || absolute.startsWith(`${managedRoot}${path.sep}`)) continue;
        if (isDependencyPath(relative)) {
          skippedDependencies += 1;
          continue;
        }
        if (await copyEntry(absolute, path.join(worktreePath, relative))) {
          untrackedCopied.push(relative);
        } else {
          skippedSymlinks += 1;
        }
      }
      const warnings = await this.#warnings(gitRoot);
      if (skippedSymlinks > 0) {
        warnings.push(`符号链接未复制（${skippedSymlinks} 个）`);
      }
      if (
        skippedDependencies > 0 &&
        !warnings.some((warning) => warning.includes("依赖目录"))
      ) {
        warnings.push(`依赖目录未复制（${skippedDependencies} 个文件）`);
      }
      return {
        worktreePath,
        cwd: path.join(worktreePath, relativeCwd),
        gitRoot,
        head,
        untrackedCopied,
        warnings,
      };
    } catch (error) {
      if (worktreeAdded) {
        await this.#runGit(["-C", gitRoot, "worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      }
      await rm(sessionRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async removeSnapshot(snapshot: Pick<ExperimentWorkspaceSnapshot, "worktreePath" | "gitRoot">): Promise<void> {
    const worktree = path.resolve(snapshot.worktreePath);
    const root = path.resolve(this.#experimentsRoot);
    if (worktree !== path.join(root, path.relative(root, worktree)) || !worktree.startsWith(`${root}${path.sep}`)) {
      throw new Error("禁止移除受管理目录之外的工作区");
    }
    await this.#runGit(["-C", path.resolve(snapshot.gitRoot), "worktree", "remove", "--force", worktree]).catch(() => undefined);
    await rm(worktree, { recursive: true, force: true });
    const sessionRoot = path.dirname(worktree);
    await rm(sessionRoot, { recursive: true, force: true });
  }

  async #gitInfo(source: string): Promise<{ gitRoot: string; head: string }> {
    let gitRoot: string;
    try {
      gitRoot = String(await this.#runGit(["-C", source, "rev-parse", "--show-toplevel"])).trim();
    } catch {
      throw new Error("实验 Fork 需要 Git 仓库");
    }
    if (!gitRoot) throw new Error("实验 Fork 需要 Git 仓库");
    try {
      const head = String(await this.#runGit(["-C", gitRoot, "rev-parse", "--verify", "HEAD"])).trim();
      if (!head) throw new Error("仓库没有有效 HEAD");
      return { gitRoot: await realpath(gitRoot), head };
    } catch {
      throw new Error("仓库没有有效 HEAD；请先创建初始提交");
    }
  }

  async #warnings(gitRoot: string): Promise<string[]> {
    const warnings: string[] = [];
    const ignored = splitNull(Buffer.from(await this.#runGit(["-C", gitRoot, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"]))).filter(Boolean);
    if (ignored.length) warnings.push(`忽略文件未复制（${ignored.length} 个）`);
    const submodules = String(await this.#runGit(["-C", gitRoot, "submodule", "status", "--recursive"])).trim();
    if (submodules) warnings.push("Submodule 内容未复制");
    if (ignored.some((item) => item === "node_modules" || item.startsWith("node_modules/"))) warnings.push("依赖目录未复制");
    return warnings;
  }
}

function splitNull(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

function isDependencyPath(relative: string): boolean {
  return relative.split(/[\\/]/).includes("node_modules");
}

async function copyEntry(source: string, target: string): Promise<boolean> {
  const info = await lstat(source);
  await mkdir(path.dirname(target), { recursive: true });
  if (info.isSymbolicLink()) {
    // 保留绝对/上级相对链接可能让实验写回父仓库或仓库外，违反隔离承诺。
    return false;
  } else if (info.isFile()) {
    await copyFile(source, target);
    return true;
  }
  return false;
}

async function defaultGitRunner(args: string[], options: { cwd?: string } = {}): Promise<Buffer | string> {
  const result = await execFileAsync("git", args, {
    cwd: options.cwd,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "buffer",
  });
  return result.stdout;
}
