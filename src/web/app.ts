import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_SCHEMA, toPublicConfig } from "../config/schema.js";
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
  MemoryHistoryError,
  MemoryService,
  type MemoryDocumentId,
} from "./memory.js";
import { parseRunCommand, stripScheduleFlags } from "../core/run-task.js";
import { extractRunSummary } from "../core/run-summary.js";
import { exportSessionHtml } from "./export-session.js";
import {
  LOBBY_KEY,
  ProjectRegistry,
} from "./project-registry.js";
import { SchedulerHub } from "./scheduler-hub.js";
import { computeSessionStats } from "./stats.js";

export function createWebApp(
  configService: ConfigService,
  sessionManager?: WebSessionManager,
  /** 在业务路由之前挂载的中间件（如访问密码认证）；Hono 按注册顺序执行，必须先于路由 */
  mountBeforeRoutes?: (app: Hono) => void,
  schedulerHub?: SchedulerHub,
): Hono & { registry: ProjectRegistry } {
  const app = new Hono();
  mountBeforeRoutes?.(app);
  const memoryService = new MemoryService({
    cwd: configService.cwd,
    homeDir: configService.homeDir,
    ...(sessionManager ? { sessions: sessionManager } : {}),
  });

  // 多项目注册表：同一 Web 进程可切换多个项目（按 cwd 缓存各自的管理器/配置）
  const registry = new ProjectRegistry({
    defaultCwd: configService.cwd,
    homeDir: configService.homeDir,
  });

  /** 解析请求指向的项目资源；未传 project 时用启动目录项目（向后兼容）。 */
  async function resolveProject(context: {
    req: { query: (k: string) => string | undefined };
  }): Promise<{
    configService: ConfigService;
    sessionManager: WebSessionManager;
    memoryService: MemoryService;
  }> {
    const key = context.req.query("project");
    if (!key) {
      // 未指定项目：默认（启动目录）单例
      if (!sessionManager) {
        return {
          configService,
          sessionManager: undefined as unknown as WebSessionManager,
          memoryService,
        };
      }
      return { configService, sessionManager, memoryService };
    }
    const { cwd, resources } = await registry.resolve(key);
    return {
      configService: resources.configService,
      sessionManager: resources.sessionManager,
      memoryService: new MemoryService({
        cwd,
        homeDir: configService.homeDir,
        sessions: resources.sessionManager,
      }),
    };
  }

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

  app.get("/api/config/schema", (context) =>
    context.json({ fields: CONFIG_SCHEMA }),
  );

  app.get("/api/config", async (context) => {
    const scope = parseScope(context.req.query("scope"));
    const target = await resolveProject(context);
    return context.json({
      scope,
      config: await target.configService.readPublic(scope),
    });
  });

  app.get("/api/config/effective", async (context) => {
    const target = await resolveProject(context);
    return context.json({
      config: toPublicConfig(await target.configService.readEffective()),
    });
  });

  app.get("/api/config/key-overrides", async (context) => {
    const target = await resolveProject(context);
    return context.json({
      project: await target.configService.findProjectKeyOverrides(),
    });
  });

  app.put("/api/config", async (context) => {
    try {
      const scope = parseScope(context.req.query("scope"));
      const target = await resolveProject(context);
      const incoming = await context.req.json();
      const config = await target.configService.write(scope, incoming);
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
    const target = await resolveProject(context);
    const body = (await context.req.json()) as {
      providerId?: string;
      model?: string;
    };
    const config = await target.configService.read(scope);
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

  app.get("/api/sessions", async (context) => {
    const target = await resolveProject(context);
    if (!target.sessionManager) return context.json({ sessions: [] });
    return context.json({ sessions: target.sessionManager.list() });
  });

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

  app.post("/api/sessions", async (context) => {
    const target = await resolveProject(context);
    const sessionManager = target.sessionManager;
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

  app.post("/api/sessions/:id/input", async (context) => {
    const target = await resolveProject(context);
    const session = target.sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    try {
      const body = (await context.req.json()) as {
        task?: string;
        message?: string;
        confirmBounds?: boolean;
        steer?: boolean;
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
      void session
        .sendInput(
          task,
          undefined,
          body.steer === true ? { steer: true } : undefined,
        )
        .catch((error) => {
          // 兜底：sendInput 内部已把 loop/flush 错误转为会话 error 事件（SSE 可见），
          // 此处防未处理 rejection 崩进程
          if (error instanceof Error) {
            console.error(`[web] sendInput 未处理错误：${error.message}`);
          }
        });
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
    const target = await resolveProject(context);
    const session = target.sessionManager?.get(context.req.param("id"));
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

  // 会话导出：自包含 HTML（无外部依赖，可在任意浏览器打开回看）
  app.get("/api/sessions/:id/export", async (context) => {
    const target = await resolveProject(context);
    const session = target.sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    const summary = session.summary();
    const html = exportSessionHtml({
      sessionId: session.id,
      title: summary.title,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      permissionMode: summary.permissionMode,
      records: session.events(),
    });
    return context.body(html, 200, {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="myagent-${session.id}.html"`,
    });
  });

  app.post("/api/sessions/:id/interrupt", async (context) => {
    const target = await resolveProject(context);
    const session = target.sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    return session.interrupt()
      ? context.json({ interrupted: true })
      : context.json({ error: "会话当前未运行" }, 409);
  });

  // 续跑崩溃中断的任务（run_started 无配对 run_finished）
  app.post("/api/sessions/:id/resume", async (context) => {
    const target = await resolveProject(context);
    const session = target.sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    const interrupted = session.interruptedTask();
    if (!interrupted) {
      return context.json({ error: "会话没有中断的任务可续跑" }, 409);
    }
    try {
      await session.resumeTask();
      return context.json({ resumed: true, taskId: interrupted.taskId });
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error ? error.message : "续跑任务失败",
        },
        409,
      );
    }
  });

  app.get("/api/sessions/:id/branches", async (context) => {
    const target = await resolveProject(context);
    const session = target.sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    return context.json({
      branches: session.branches(),
      currentBranchId: session.currentBranchId(),
    });
  });

  // 书签：GET 列出 / POST 打标（body: seq, name；name 空串表示移除）
  app.get("/api/sessions/:id/bookmarks", async (context) => {
    const target = await resolveProject(context);
    const session = target.sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    return context.json({ bookmarks: session.bookmarks() });
  });

  app.post("/api/sessions/:id/bookmarks", async (context) => {
    const target = await resolveProject(context);
    const session = target.sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    const body = (await context.req.json()) as {
      seq?: unknown;
      name?: unknown;
    };
    if (
      typeof body.seq !== "number" ||
      !Number.isInteger(body.seq) ||
      typeof body.name !== "string"
    ) {
      return context.json({ error: "seq 与 name 参数无效" }, 400);
    }
    try {
      if (body.name.trim()) session.addBookmark(body.seq, body.name);
      else session.removeBookmark(body.seq);
      return context.json({ bookmarks: session.bookmarks() });
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error ? error.message : "书签操作失败",
        },
        400,
      );
    }
  });

  app.post("/api/sessions/:id/switch-branch", async (context) => {
    const target = await resolveProject(context);
    const session = target.sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    try {
      const body = (await context.req.json()) as { branchId?: string };
      const branchId = body.branchId?.trim();
      if (!branchId) {
        return context.json({ error: "缺少 branchId" }, 400);
      }
      session.switchBranch(branchId);
      return context.json({
        switched: true,
        currentBranchId: session.currentBranchId(),
      });
    } catch (error) {
      return context.json(
        { error: error instanceof Error ? error.message : "切换分支失败" },
        409,
      );
    }
  });

  app.delete("/api/sessions/:id", async (context) => {
    const target = await resolveProject(context);
    if (!target.sessionManager) {
      return context.json({ error: "会话服务不可用" }, 503);
    }
    const deleted = await target.sessionManager.deleteSession(context.req.param("id"));
    return deleted
      ? context.json({ deleted: true })
      : context.json({ error: "会话不存在" }, 404);
  });

  app.get("/api/sessions/:id/summary", async (context) => {
    const target = await resolveProject(context);
    const session = target.sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    const run = extractRunSummary(session.events());
    if (!run) return context.json({ run: null });
    const summary = session.summary();
    return context.json({
      run,
      totals: {
        totalCostCny: summary.totalCostCny,
        totalInputTokens: summary.totalInputTokens,
        totalOutputTokens: summary.totalOutputTokens,
        status: summary.status,
      },
    });
  });

  app.get("/api/sessions/:id/stream", async (context) => {
    const target = await resolveProject(context);
    const session = target.sessionManager?.get(context.req.param("id"));
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

  // 挂载注册表引用：进程优雅退出时释放全部项目写锁（server.ts 信号处理使用）
  return Object.assign(app, { registry });
}

function parseScope(value?: string): ConfigScope {
  return value === "project" ? "project" : "global";
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
