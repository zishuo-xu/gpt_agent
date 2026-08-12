import type { Hono } from "hono";
import { parseRunCommand, stripScheduleFlags } from "../core/run-task.js";
import type { WebRouteDeps } from "./routes-context.js";

/** 定时任务路由：注册（剥离 --at/--every 存干净命令）/ 列表 / 删除 */
export function registerScheduledRoutes(
  app: Hono,
  deps: WebRouteDeps,
): void {
  const { schedulerHub } = deps;

  app.get("/api/scheduled", async (context) => {
    if (!schedulerHub) return context.json({ tasks: [] });
    const key = context.req.query("project");
    if (!key) return context.json({ tasks: [] });
    const scheduler = await schedulerHub.ensureLoaded(key);
    return context.json({ tasks: scheduler.list() });
  });

  app.post("/api/scheduled", async (context) => {
    if (!schedulerHub) {
      return context.json({ error: "定时任务不可用（未启用 Web 服务）" }, 500);
    }
    const key = context.req.query("project");
    if (!key) return context.json({ error: "缺少 project 参数" }, 400);
    const body = (await context.req.json()) as { command?: unknown };
    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!command) return context.json({ error: "命令不能为空" }, 400);
    try {
      // 原命令先整体解析（校验全部参数并取调度字段），落库时剥离 --at/--every 存干净命令
      const parsed = parseRunCommand(command);
      if (!parsed.at && !parsed.everyMinutes) {
        return context.json(
          { error: "定时任务需要 --at HH:mm 或 --every N 分钟" },
          400,
        );
      }
      const cleanCommand = stripScheduleFlags(command);
      const options = parseRunCommand(cleanCommand);
      const scheduler = await schedulerHub.ensureLoaded(key);
      const task = await scheduler.add({
        command: cleanCommand,
        options,
        // 只有 --every 时从注册时刻顺延一个周期开始
        at:
          parsed.at ??
          new Date(Date.now() + (parsed.everyMinutes ?? 1) * 60_000).toISOString(),
        ...(parsed.everyMinutes === undefined
          ? {}
          : { everyMinutes: parsed.everyMinutes }),
      });
      return context.json({ task }, 201);
    } catch (error) {
      return context.json(
        { error: error instanceof Error ? error.message : "注册定时任务失败" },
        400,
      );
    }
  });

  app.delete("/api/scheduled/:id", async (context) => {
    if (!schedulerHub) return context.json({ error: "定时任务不可用" }, 500);
    const key = context.req.query("project");
    if (!key) return context.json({ error: "缺少 project 参数" }, 400);
    const scheduler = await schedulerHub.ensureLoaded(key);
    const removed = await scheduler.remove(context.req.param("id"));
    if (!removed) return context.json({ error: "定时任务不存在" }, 404);
    return context.json({ removed: true });
  });
}
