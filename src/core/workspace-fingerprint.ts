import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const UNTRACKED_HASH_LIMIT = 200;

/** Git tree identity at a moment in time. Not a file snapshot. */
export interface WorkspaceFingerprint {
  head: string;
  dirty: string;
}

export type GitRunner = (
  args: string[],
  options?: { cwd?: string },
) => Promise<Buffer | string>;

export function isWorkspaceFingerprint(
  value: unknown,
): value is WorkspaceFingerprint {
  if (!value || typeof value !== "object") return false;
  const fingerprint = value as Partial<WorkspaceFingerprint>;
  return (
    typeof fingerprint.head === "string" &&
    fingerprint.head.length > 0 &&
    typeof fingerprint.dirty === "string" &&
    fingerprint.dirty.length > 0
  );
}

export function workspaceFingerprintKey(fingerprint: WorkspaceFingerprint): string {
  return `${fingerprint.head}:${fingerprint.dirty}`;
}

/**
 * Cheap, fail-soft sensor: HEAD + dirty hash of tracked diffs and
 * non-ignored untracked files. Returns undefined when cwd is not a Git repo.
 */
export async function captureWorkspaceFingerprint(
  cwd: string,
  runGit: GitRunner = defaultGitRunner,
): Promise<WorkspaceFingerprint | undefined> {
  try {
    const gitRoot = String(
      await runGit(["-C", cwd, "rev-parse", "--show-toplevel"]),
    ).trim();
    if (!gitRoot) return undefined;
    const head = String(
      await runGit(["-C", gitRoot, "rev-parse", "--verify", "HEAD"]),
    ).trim();
    if (!head) return undefined;
    const porcelain = String(
      await runGit(["-C", gitRoot, "status", "--porcelain=v1", "-unormal"]),
    );
    const diff = Buffer.from(
      await runGit(["-C", gitRoot, "diff", "--binary", "HEAD"]),
    );
    const untracked = splitNull(
      Buffer.from(
        await runGit([
          "-C",
          gitRoot,
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ]),
      ),
    ).filter((relative) => !relative.split(/[\\/]/).includes("node_modules"));
    const hash = createHash("sha256");
    hash.update(porcelain);
    hash.update("\n");
    hash.update(diff);
    hash.update("\n");
    const limited = untracked.slice(0, UNTRACKED_HASH_LIMIT);
    for (const relative of limited) {
      hash.update(relative);
      hash.update("\0");
      const absolute = path.join(gitRoot, relative);
      try {
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) {
          hash.update("symlink");
        } else if (info.isFile()) {
          hash.update(await readFile(absolute));
        } else {
          hash.update("other");
        }
      } catch {
        hash.update("missing");
      }
      hash.update("\n");
    }
    if (untracked.length > UNTRACKED_HASH_LIMIT) {
      hash.update(`truncated:${untracked.length}\n`);
    }
    return { head, dirty: hash.digest("hex") };
  } catch {
    return undefined;
  }
}

function splitNull(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

async function defaultGitRunner(
  args: string[],
  options: { cwd?: string } = {},
): Promise<Buffer | string> {
  const result = await execFileAsync("git", args, {
    cwd: options.cwd,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "buffer",
  });
  return result.stdout;
}
