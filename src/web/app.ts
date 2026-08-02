import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { CONFIG_SCHEMA } from "../config/schema.js";
import {
  ConfigService,
  ConfigValidationError,
  type ConfigScope,
} from "../config/service.js";
import { testModelConnection } from "../model/test-connection.js";
import {
  WebSessionManager,
  type WebSessionEvent,
} from "./sessions.js";
import {
  MemoryService,
  type MemoryDocumentId,
} from "./memory.js";
import { parseRunCommand } from "../core/run-task.js";

export function createWebApp(
  configService: ConfigService,
  sessionManager?: WebSessionManager,
): Hono {
  const app = new Hono();
  const memoryService = new MemoryService({
    cwd: configService.cwd,
    homeDir: configService.homeDir,
    ...(sessionManager ? { sessions: sessionManager } : {}),
  });

  app.get("/api/health", (context) =>
    context.json({ ok: true, service: "myagent-web" }),
  );

  app.get("/api/config/schema", (context) =>
    context.json({ fields: CONFIG_SCHEMA }),
  );

  app.get("/api/config", async (context) => {
    const scope = parseScope(context.req.query("scope"));
    return context.json({
      scope,
      config: await configService.readPublic(scope),
    });
  });

  app.put("/api/config", async (context) => {
    try {
      const scope = parseScope(context.req.query("scope"));
      const incoming = await context.req.json();
      const config = await configService.write(scope, incoming);
      return context.json({ scope, config, saved: true });
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return context.json(
          { saved: false, error: error.message, issues: error.issues },
          400,
        );
      }
      throw error;
    }
  });

  app.post("/api/config/test", async (context) => {
    const scope = parseScope(context.req.query("scope"));
    const body = (await context.req.json()) as {
      providerId?: string;
      model?: string;
    };
    const config = await configService.read(scope);
    const provider = config.providers.find(
      (candidate) => candidate.id === body.providerId,
    );
    if (!provider) {
      return context.json(
        { ok: false, reachable: false, message: "未找到指定模型渠道" },
        400,
      );
    }
    const model = body.model || provider.models[0];
    if (!model) {
      return context.json(
        { ok: false, reachable: false, message: "该渠道尚未配置模型" },
        400,
      );
    }
    const result = await testModelConnection(provider, model);
    return context.json(result, result.ok ? 200 : 422);
  });

  app.get("/api/sessions", (context) => {
    if (!sessionManager) return context.json({ sessions: [] });
    return context.json({ sessions: sessionManager.list() });
  });

  app.get("/api/memory", async (context) =>
    context.json(await memoryService.list()),
  );

  app.put("/api/memory/:id", async (context) => {
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
      document: await memoryService.write(id, body.content),
    });
  });

  app.post("/api/sessions", async (context) => {
    if (!sessionManager) {
      return context.json({ error: "会话服务未启用" }, 503);
    }
    try {
      const body = (await context.req.json()) as {
        task?: string;
        permissionMode?: "strict" | "normal" | "trust";
        confirmBounds?: boolean;
      };
      const task = body.task?.trim();
      if (!task) return context.json({ error: "task is required" }, 400);
      const run = task.startsWith("/run")
        ? parseRunCommand(task)
        : undefined;
      if (
        run &&
        run.hardRules.length > 0 &&
        !body.confirmBounds
      ) {
        return context.json(
          {
            error: "需要先确认任务硬边界",
            requiresConfirmation: true,
            hardRules: run.hardRules,
            semanticBounds: run.semanticBounds,
          },
          409,
        );
      }
      const session = await sessionManager.create(
        task,
        body.permissionMode ?? "normal",
      );
      return context.json({ session: session.summary() }, 201);
    } catch (error) {
      return context.json(
        {
          error: error instanceof Error ? error.message : "创建会话失败",
        },
        400,
      );
    }
  });

  app.post("/api/sessions/:id/input", async (context) => {
    const session = sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    try {
      const body = (await context.req.json()) as {
        task?: string;
        message?: string;
        confirmBounds?: boolean;
      };
      // 前端对"已有会话发消息"使用 message 字段，对"新建会话"使用 task；此处统一兼容
      const task = (body.task ?? body.message)?.trim();
      if (!task) return context.json({ error: "消息不能为空" }, 400);
      if (task.startsWith("/run")) {
        if (session.isProcessing()) {
          return context.json(
            { error: "当前会话已有任务在运行" },
            409,
          );
        }
        const run = parseRunCommand(task);
        if (run.hardRules.length > 0 && !body.confirmBounds) {
          return context.json(
            {
              error: "需要先确认任务硬边界",
              requiresConfirmation: true,
              hardRules: run.hardRules,
              semanticBounds: run.semanticBounds,
            },
            409,
          );
        }
        session.startRunTask(run);
        return context.json({ accepted: true, queued: false });
      }
      const queued = session.isProcessing();
      void session.sendInput(task);
      return context.json({ accepted: true, queued });
    } catch (error) {
      return context.json(
        { error: error instanceof Error ? error.message : "发送失败" },
        409,
      );
    }
  });

  app.post("/api/run/preview", async (context) => {
    try {
      const body = (await context.req.json()) as {
        command?: string;
      };
      if (!body.command?.trim()) {
        return context.json({ error: "命令不能为空" }, 400);
      }
      return context.json({
        task: parseRunCommand(body.command),
      });
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "/run 参数无效",
        },
        400,
      );
    }
  });

  app.post("/api/sessions/:id/permission", async (context) => {
    const session = sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    const body = (await context.req.json()) as {
      callId?: string;
      granted?: boolean;
      scope?: "once" | "session" | "project" | "global";
      feedback?: string;
    };
    if (!body.callId || typeof body.granted !== "boolean") {
      return context.json({ error: "审批参数无效" }, 400);
    }
    const resolved = session.resolvePermission(body.callId, {
      granted: body.granted,
      scope: body.scope ?? "once",
      ...(body.feedback?.trim()
        ? { feedback: body.feedback.trim() }
        : {}),
    });
    return resolved
      ? context.json({ resolved: true })
      : context.json({ error: "审批已失效或不存在" }, 409);
  });

  app.post("/api/sessions/:id/interrupt", (context) => {
    const session = sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    return session.interrupt()
      ? context.json({ interrupted: true })
      : context.json({ error: "会话当前未运行" }, 409);
  });

  app.delete("/api/sessions/:id", async (context) => {
    if (!sessionManager) {
      return context.json({ error: "会话服务不可用" }, 503);
    }
    const deleted = await sessionManager.deleteSession(context.req.param("id"));
    return deleted
      ? context.json({ deleted: true })
      : context.json({ error: "会话不存在" }, 404);
  });

  app.get("/api/sessions/:id/stream", (context) => {
    const session = sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    const after = Number(context.req.query("after") ?? "0") || 0;
    return streamSSE(context, async (stream) => {
      const queue = session.events(after);
      let wake: ((event: WebSessionEvent | null) => void) | undefined;
      const unsubscribe = session.subscribe((event) => {
        if (wake) {
          const resolve = wake;
          wake = undefined;
          resolve(event);
        } else {
          queue.push(event);
        }
      });
      const abort = () => {
        const resolve = wake;
        wake = undefined;
        resolve?.(null);
      };
      context.req.raw.signal.addEventListener("abort", abort, { once: true });

      try {
        while (!context.req.raw.signal.aborted) {
          const event =
            queue.shift() ??
            (await new Promise<WebSessionEvent | null>((resolve) => {
              wake = resolve;
            }));
          if (!event) break;
          await stream.writeSSE({
            id: String(event.seq),
            data: JSON.stringify(event),
          });
        }
      } finally {
        unsubscribe();
        context.req.raw.signal.removeEventListener("abort", abort);
      }
    });
  });

  return app;
}

function parseScope(value?: string): ConfigScope {
  return value === "project" ? "project" : "global";
}
