import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectRegistry } from "./project-registry.js";
test("listProjects 过滤已删除目录的残留项目（幽灵项目）", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-registry-"));
  const homeDir = path.join(root, "home");
  const stateDir = path.join(homeDir, ".myagent");
  const liveCwd = path.join(root, "live-project");
  // 目录不存在：e2e/临时目录被清理后 project.json 元数据残留的典型形态
  const ghostCwd = path.join(root, "ghost-project");
  await mkdir(liveCwd, { recursive: true });
  await mkdir(
    path.join(stateDir, "projects", ProjectRegistry.projectKey(liveCwd)),
    { recursive: true },
  );
  await writeFile(
    path.join(
      stateDir,
      "projects",
      ProjectRegistry.projectKey(liveCwd),
      "project.json",
    ),
    JSON.stringify({
      name: "live-project",
      cwd: liveCwd,
      updatedAt: "2026-08-14T00:00:00.000Z",
    }),
  );
  await mkdir(
    path.join(stateDir, "projects", ProjectRegistry.projectKey(ghostCwd)),
    { recursive: true },
  );
  await writeFile(
    path.join(
      stateDir,
      "projects",
      ProjectRegistry.projectKey(ghostCwd),
      "project.json",
    ),
    JSON.stringify({
      name: "ghost-project",
      cwd: ghostCwd,
      updatedAt: "2026-08-13T00:00:00.000Z",
    }),
  );
  const registry = new ProjectRegistry({
    defaultCwd: path.join(root, "default"),
    homeDir,
    stateDir,
  });
  const projects = await registry.listProjects();
  const names = projects.map((project) => project.name);
  assert.ok(names.includes("live-project"), "存在的目录应列出");
  assert.ok(
    !names.includes("ghost-project"),
    "目录已删除的残留不应列出",
  );
});

test("并发首触同一项目：共享同一加载，不产生实例锁自竞态", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-registry-"));
  const homeDir = path.join(root, "home");
  const stateDir = path.join(homeDir, ".myagent");
  const projectCwd = path.join(root, "race-project");
  await mkdir(projectCwd, { recursive: true });
  const registry = new ProjectRegistry({
    defaultCwd: path.join(root, "default"),
    homeDir,
    stateDir,
  });
  // 模拟前端切项目时的并发首触（sessions/stats/memory 等同时解析该项目）
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => registry.getByCwd(projectCwd)),
  );
  const managers = results.map((result, index) => {
    if (result.status !== "fulfilled") {
      const reason = result.status === "rejected" ? String(result.reason) : "";
      assert.fail(`第 ${index} 个并发请求不应失败：${reason}`);
    }
    return result.value.sessionManager;
  });
  for (const manager of managers) {
    assert.equal(manager, managers[0], "并发调用应拿到同一管理器实例");
  }
});

test("并发首触大厅：共享同一加载，不产生实例锁自竞态", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-registry-"));
  const registry = new ProjectRegistry({
    defaultCwd: path.join(root, "default"),
    homeDir: path.join(root, "home"),
    stateDir: path.join(root, "home", ".myagent"),
  });
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => registry.getLobby()),
  );
  const managers = results.map((result) => {
    if (result.status !== "fulfilled") {
      const reason = result.status === "rejected" ? String(result.reason) : "";
      assert.fail(`大厅并发首触不应失败：${reason}`);
    }
    return result.value.sessionManager;
  });
  for (const manager of managers) {
    assert.equal(manager, managers[0]);
  }
});

test("首触失败后释放项目锁：无需重启即可重新加载", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-registry-"));
  const homeDir = path.join(root, "home");
  const stateDir = path.join(homeDir, ".myagent");
  const projectCwd = path.join(root, "flaky-project");
  await mkdir(projectCwd, { recursive: true });
  const registry = new ProjectRegistry({
    defaultCwd: path.join(root, "default"),
    homeDir,
    stateDir,
  });
  // sessions 路径是普通文件 → restore 在拿到锁之后 readdir 抛 ENOTDIR（首触失败）
  const sessionsPath = path.join(
    stateDir,
    "projects",
    ProjectRegistry.projectKey(projectCwd),
    "sessions",
  );
  await mkdir(path.dirname(sessionsPath), { recursive: true });
  await writeFile(sessionsPath, "not a dir");
  const first = await registry.getByCwd(projectCwd).then(
    () => "fulfilled",
    (error) => String(error),
  );
  assert.ok(first.includes("ENOTDIR"), `首次加载应暴露真实错误，实际：${first}`);
  // 修复底层故障后重新加载：旧实现锁残留（持有者=本进程存活 pid）会永久"被占用"
  await rm(sessionsPath, { recursive: true });
  await mkdir(sessionsPath, { recursive: true });
  const second = await registry.getByCwd(projectCwd);
  assert.ok(second.sessionManager, "锁释放后重新加载应成功");
});
