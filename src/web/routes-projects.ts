import type { Hono } from "hono";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LOBBY_KEY, ProjectRegistry } from "./project-registry.js";
import type { WebRouteDeps } from "./routes-context.js";

/** 项目与文件浏览路由：health / projects / fs（目录选择器） */
export function registerProjectRoutes(
  app: Hono,
  deps: WebRouteDeps,
): void {
  const { registry } = deps;

  app.get("/api/health", (context) =>
    context.json({ ok: true, service: "myagent-web" }),
  );

  app.get("/api/projects", async (context) => {
    const projects = await registry.listProjects();
    const defaultKey = ProjectRegistry.projectKey(registry.defaultCwd);
    // 大厅（只读不写）始终作为一个可选执行环境
    const entries = [
      { key: LOBBY_KEY, name: "大厅（不操作文件）", cwd: registry.lobbyCwd(), lobby: true },
      ...projects,
    ];
    return context.json({
      projects: entries,
      defaultKey,
      currentKey: context.req.query("project") ?? defaultKey,
    });
  });

  app.get("/api/fs/roots", (context) =>
    context.json({ roots: listFsRoots() }),
  );

  app.get("/api/fs/list", async (context) => {
    const rawPath = context.req.query("path");
    if (!rawPath) {
      return context.json({ error: "缺少 path 参数" }, 400);
    }
    try {
      const entries = await listDirectory(rawPath);
      return context.json({ path: rawPath, entries });
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "读取目录失败",
        },
        400,
      );
    }
  });

  app.post("/api/projects/open", async (context) => {
    const body = (await context.req.json()) as { path?: string };
    const target = body.path?.trim();
    if (!target) {
      return context.json({ error: "缺少项目路径" }, 400);
    }
    try {
      const stat = await fsStat(target);
      if (!stat?.isDirectory()) {
        return context.json({ error: "路径不是目录" }, 400);
      }
      const resources = await registry.getByCwd(target);
      const key = ProjectRegistry.projectKey(target);
      return context.json({
        opened: true,
        project: {
          key,
          name: path.basename(target),
          cwd: target,
        },
        sessions: resources.sessionManager.list(),
      });
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "无法打开项目",
        },
        400,
      );
    }
  });
}

/** 文件系统浏览（只读，供"打开项目"目录选择器使用）。 */

interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/** 目录选择器的起始根（含家目录与常用入口）。 */
function listFsRoots(): Array<{ name: string; path: string }> {
  const home = os.homedir();
  const roots = [{ name: home, path: home }];
  for (const p of ["/", "/Users", "/Volumes", "/Applications", "/tmp"]) {
    if (p !== home) roots.push({ name: p, path: p });
  }
  return roots;
}

/** 列出目录下的子项（只列目录，跳过隐藏项与符号链接，避免跳入系统目录）。 */
async function listDirectory(dir: string): Promise<FsEntry[]> {
  const names = await readdir(dir, { withFileTypes: true });
  const entries: FsEntry[] = [];
  for (const entry of names) {
    const name = entry.name;
    if (name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) continue;
    entries.push({
      name,
      path: path.join(dir, name),
      isDirectory: true,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

async function fsStat(target: string) {
  try {
    return await stat(target);
  } catch {
    return undefined;
  }
}
