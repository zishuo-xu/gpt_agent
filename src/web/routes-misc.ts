import type { Hono } from "hono";
import {
  MemoryHistoryError,
  type MemoryDocumentId,
} from "./memory.js";
import { computeSessionStats } from "./stats.js";
import type { WebRouteDeps } from "./routes-context.js";

/** 统计 / 记忆 / 插件路由（跨会话资源，均走项目解析） */
export function registerMiscRoutes(
  app: Hono,
  deps: WebRouteDeps,
): void {
  const { resolveProject } = deps;

  app.get("/api/stats", async (context) => {
    const target = await resolveProject(context);
    if (!target.sessionManager) {
      return context.json({ totals: {}, byDay: [], sessions: [] });
    }
    return context.json(computeSessionStats(target.sessionManager.list()));
  });

  app.get("/api/memory", async (context) => {
    const target = await resolveProject(context);
    return context.json(await target.memoryService.list());
  });

  app.get("/api/memory/history", async (context) => {
    const target = await resolveProject(context);
    const rawPath = context.req.query("path");
    if (!rawPath) {
      return context.json({ error: "缺少 path 参数" }, 400);
    }
    try {
      return context.json(await target.memoryService.getHistory(rawPath));
    } catch (error) {
      if (error instanceof MemoryHistoryError) {
        return context.json({ error: error.message }, error.status);
      }
      throw error;
    }
  });

  app.put("/api/memory/:id", async (context) => {
    const target = await resolveProject(context);
    const id = context.req.param("id") as MemoryDocumentId;
    if (
      !["preferences", "conventions", "pitfalls", "decisions"].includes(
        id,
      )
    ) {
      return context.json({ error: "未知记忆文档" }, 404);
    }
    const body = (await context.req.json()) as { content?: unknown };
    if (typeof body.content !== "string") {
      return context.json({ error: "content 必须是字符串" }, 400);
    }
    return context.json({
      saved: true,
      document: await target.memoryService.write(id, body.content),
    });
  });

  app.get("/api/plugins", async (context) => {
    const target = await resolveProject(context);
    if (!target.sessionManager) {
      return context.json({ loaded: [], errors: [], stats: [], disabled: [] });
    }
    return context.json(target.sessionManager.pluginStatus());
  });

  app.post("/api/plugins/reload", async (context) => {
    const target = await resolveProject(context);
    if (!target.sessionManager) {
      return context.json({ error: "插件管理器不可用" }, 500);
    }
    await target.sessionManager.reloadPlugins();
    return context.json(target.sessionManager.pluginStatus());
  });

  app.post("/api/plugins/:name/enabled", async (context) => {
    const target = await resolveProject(context);
    if (!target.sessionManager) {
      return context.json({ error: "插件管理器不可用" }, 500);
    }
    const name = context.req.param("name") as string;
    const body = (await context.req.json()) as { enabled?: boolean };
    const enabled = body.enabled !== false;
    const ok = await target.sessionManager.pluginSetEnabled(name, enabled);
    if (!ok) return context.json({ error: `插件未加载：${name}` }, 404);
    return context.json({ name, enabled });
  });
}
