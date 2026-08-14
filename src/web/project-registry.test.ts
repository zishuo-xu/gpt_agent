import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
