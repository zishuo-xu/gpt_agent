import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ExperimentWorkspaceManager } from "./experiment-workspace.js";

const execFile = promisify(execFileCb);
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd, encoding: "utf8" });
  return result.stdout;
}
async function repo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-experiment-"));
  await git(cwd, "init", "-q");
  await git(cwd, "config", "user.email", "test@example.com");
  await git(cwd, "config", "user.name", "Test");
  await writeFile(path.join(cwd, "tracked.txt"), "base\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "initial");
  return cwd;
}

test("ExperimentWorkspace copies staged/unstaged/deleted/binary and untracked state", async () => {
  const cwd = await repo();
  const binary = Buffer.from([0, 1, 2, 255]);
  await writeFile(path.join(cwd, "tracked.txt"), "unstaged\n");
  await writeFile(path.join(cwd, "staged.txt"), "staged\n");
  await git(cwd, "add", "staged.txt");
  await writeFile(path.join(cwd, "binary.bin"), binary);
  await git(cwd, "add", "binary.bin");
  await git(cwd, "rm", "-q", "-f", "tracked.txt");
  await writeFile(path.join(cwd, "untracked.txt"), "untracked\n");
  const manager = new ExperimentWorkspaceManager({ experimentsRoot: path.join(cwd, ".experiments") });
  const snapshot = await manager.createSnapshot("s1", cwd);
  assert.equal(await stat(snapshot.worktreePath).then(() => true), true);
  assert.equal(await readFile(path.join(snapshot.cwd, "staged.txt"), "utf8"), "staged\n");
  assert.equal(await readFile(path.join(snapshot.cwd, "untracked.txt"), "utf8"), "untracked\n");
  assert.deepEqual([...await readFile(path.join(snapshot.cwd, "binary.bin"))], [...binary]);
  await assert.rejects(() => stat(path.join(snapshot.cwd, "tracked.txt")));
  assert.deepEqual(snapshot.untrackedCopied, ["untracked.txt"]);
  await manager.removeSnapshot(snapshot);
  await assert.rejects(() => stat(snapshot.worktreePath));
  assert.equal(await readFile(path.join(cwd, "tracked.txt")).catch(() => "missing"), "missing");
});

test("ignored files and submodules are not copied and produce warnings", async () => {
  const cwd = await repo();
  await writeFile(path.join(cwd, ".gitignore"), "ignored.txt\nnode_modules/\n");
  await git(cwd, "add", ".gitignore");
  await git(cwd, "commit", "-qm", "ignore");
  await writeFile(path.join(cwd, "ignored.txt"), "secret");
  await mkdirSafe(path.join(cwd, "node_modules"));
  await writeFile(path.join(cwd, "node_modules", "dep.js"), "dep");
  const snapshot = await new ExperimentWorkspaceManager({ experimentsRoot: path.join(cwd, ".experiments") }).createSnapshot("s2", cwd);
  assert.ok(snapshot.warnings.some((warning) => warning.includes("忽略文件")));
  assert.ok(snapshot.warnings.some((warning) => warning.includes("依赖目录")));
});

test("untracked symlinks are skipped so the experiment cannot escape its workspace", async () => {
  const cwd = await repo();
  await symlink(path.join(cwd, "tracked.txt"), path.join(cwd, "escape-link"));
  const snapshot = await new ExperimentWorkspaceManager({
    experimentsRoot: path.join(cwd, ".experiments"),
  }).createSnapshot("symlink", cwd);
  await assert.rejects(() => stat(path.join(snapshot.cwd, "escape-link")));
  assert.ok(snapshot.warnings.some((warning) => warning.includes("符号链接")));
});

test("node_modules is skipped even when the repository forgot to ignore it", async () => {
  const cwd = await repo();
  await mkdirSafe(path.join(cwd, "packages", "app", "node_modules", "dep"));
  await writeFile(
    path.join(cwd, "packages", "app", "node_modules", "dep", "index.js"),
    "dependency",
  );
  const snapshot = await new ExperimentWorkspaceManager({
    experimentsRoot: path.join(cwd, ".experiments"),
  }).createSnapshot("dependencies", cwd);
  await assert.rejects(() =>
    stat(
      path.join(
        snapshot.cwd,
        "packages",
        "app",
        "node_modules",
        "dep",
        "index.js",
      ),
    ),
  );
  assert.ok(snapshot.warnings.some((warning) => warning.includes("依赖目录")));
});

test("non-Git and no-HEAD directories fail clearly", async () => {
  const nonGit = await mkdtemp(path.join(os.tmpdir(), "myagent-non-git-"));
  const manager = new ExperimentWorkspaceManager({ experimentsRoot: path.join(nonGit, ".experiments") });
  await assert.rejects(() => manager.createSnapshot("bad", nonGit), /Git 仓库/);
  const empty = await mkdtemp(path.join(os.tmpdir(), "myagent-empty-git-"));
  await git(empty, "init", "-q");
  await assert.rejects(() => manager.createSnapshot("empty", empty), /有效 HEAD/);
});

test("failure during snapshot rolls back managed worktree", async () => {
  const cwd = await repo();
  await writeFile(path.join(cwd, "tracked.txt"), "changed\n");
  const root = path.join(cwd, ".experiments");
  const manager = new ExperimentWorkspaceManager({
    experimentsRoot: root,
    runGit: async (args) => {
      if (args.includes("apply")) throw new Error("apply failed");
      const result = await execFile("git", args, { encoding: "buffer" });
      return result.stdout;
    },
  });
  await assert.rejects(() => manager.createSnapshot("broken", cwd), /apply failed/);
  await assert.rejects(() => stat(path.join(root, "broken")));
});

async function mkdirSafe(directory: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
}
