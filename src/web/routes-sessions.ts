import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { parseRunCommand } from "../core/run-task.js";
import { extractRunSummary } from "../core/run-summary.js";
import { exportSessionHtml } from "./export-session.js";
import type { WebSessionEvent } from "./sessions.js";
import type { WebRouteDeps } from "./routes-context.js";
import { redactTrace } from "../core/trace-redaction.js";
import { observeTurn } from "../core/turn-observation.js";
import type { RunWorkspaceMode } from "../core/run-workspace.js";
import { projectDelivery } from "../core/delivery.js";
import { captureWorkspaceFingerprint } from "../core/workspace-fingerprint.js";

/** 会话路由：集合创建 / 详情操作（输入/审批/导出/中断/续跑/分支/书签）/ SSE 事件流 */
export function registerSessionRoutes(
  app: Hono,
  deps: WebRouteDeps,
): void {
  const { resolveProject } = deps;

  app.get("/api/sessions", async (context) => {
    const target = await resolveProject(context);
    if (!target.sessionManager) return context.json({ sessions: [] });
    return context.json({ sessions: target.sessionManager.list() });
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
        planMode?: boolean;
        workspaceMode?: unknown;
      };
      const task = body.task?.trim();
      if (!task) return context.json({ error: "task is required" }, 400);
      if (body.workspaceMode !== undefined && body.workspaceMode !== "project" && body.workspaceMode !== "isolated") {
        return context.json({ error: "workspaceMode 必须是 project 或 isolated" }, 400);
      }
      const workspaceMode = body.workspaceMode as RunWorkspaceMode | undefined;
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
        { ...(body.planMode === true ? { planMode: true } : {}), ...(workspaceMode ? { workspaceMode } : {}) },
      );
      const workspace = await sessionManager.workspaceInfo(session.id);
      return context.json({ session: session.summary(), ...(workspace ? { workspace } : {}) }, 201);
    } catch (error) {
      return context.json(
        {
          error: error instanceof Error ? error.message : "创建会话失败",
        },
        400,
      );
    }
  });

  app.get("/api/sessions/:id/workspace", async (context) => {
    const target = await resolveProject(context);
    const sessionManager = target.sessionManager;
    if (!sessionManager) return context.json({ error: "会话服务未启用" }, 503);
    const id = context.req.param("id");
    if (!sessionManager.get(id)) return context.json({ error: "会话不存在" }, 404);
    return context.json({ workspace: (await sessionManager.workspaceInfo(id)) ?? null });
  });

  app.get("/api/sessions/:id/delivery", async (context) => {
    const target = await resolveProject(context);
    const sessionManager = target.sessionManager;
    if (!sessionManager) return context.json({ error: "会话服务未启用" }, 503);
    const session = sessionManager.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    const sessionSummary = session.summary();
    const delivery = projectDelivery(session.events(), { title: sessionSummary.title, status: sessionSummary.status });
    const isolated = await sessionManager.workspaceInfo(session.id);
    if (!isolated) return context.json({ delivery, workspace: { mode: "project" } });
    const current = isolated.exists ? await captureWorkspaceFingerprint(isolated.path) : undefined;
    const warnings = [...isolated.warnings];
    if (!isolated.exists) warnings.push("隔离工作区路径不存在");
    const changedSinceCreated = Boolean(current && isolated.fingerprint && (current.head !== isolated.fingerprint.head || current.dirty !== isolated.fingerprint.dirty));
    if (changedSinceCreated) warnings.push("工作区自创建后已发生变化");
    return context.json({ delivery, workspace: {
      mode: "isolated", source: isolated.sourceCwd, path: isolated.path,
      baseHead: isolated.head, exists: isolated.exists, warnings,
      ...(isolated.fingerprint ? { createdFingerprint: isolated.fingerprint } : {}),
      ...(current ? { currentHead: current.head, changedSinceCreated } : {}),
    } });
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
        planMode?: boolean;
      };
      // 前端对"已有会话发消息"使用 message 字段，对"新建会话"使用 task；此处统一兼容
      const task = (body.task ?? body.message)?.trim();
      if (!task) return context.json({ error: "消息不能为空" }, 400);
      if (body.planMode === true) {
        await session.startPlan(task);
        return context.json({ accepted: true, queued: false });
      }
      if (session.taskPlan()?.status === "awaiting_approval") {
        return context.json(
          { error: "当前计划等待决策，请先批准、修改或选择仅分析" },
          409,
        );
      }
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

  app.get("/api/sessions/:id/plan", async (context) => {
    const target = await resolveProject(context);
    const session = target.sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    return context.json({ plan: session.taskPlan() ?? null });
  });

  app.post("/api/sessions/:id/plan/decision", async (context) => {
    const target = await resolveProject(context);
    const session = target.sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    try {
      const body = (await context.req.json()) as {
        decision?: "approved" | "revision_requested" | "analysis_only";
        feedback?: string;
      };
      if (
        body.decision !== "approved" &&
        body.decision !== "revision_requested" &&
        body.decision !== "analysis_only"
      ) {
        return context.json({ error: "decision 无效" }, 400);
      }
      await session.decidePlan(body.decision, body.feedback);
      return context.json({ accepted: true, plan: session.taskPlan() });
    } catch (error) {
      return context.json(
        { error: error instanceof Error ? error.message : "计划决策失败" },
        409,
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

  /** 一次性返回会话全部事件（轨迹表格等需要整段事件做分布的消费方） */
  app.get("/api/sessions/:id/events", async (context) => {
    const target = await resolveProject(context);
    const session = target.sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    return context.json({ events: session.events() });
  });

  app.get("/api/sessions/:id/forks", async (context) => {
    const target = await resolveProject(context);
    const manager = target.sessionManager;
    if (!manager) return context.json({ error: "会话服务未启用" }, 503);
    if (!manager.get(context.req.param("id"))) {
      return context.json({ error: "父会话不存在" }, 404);
    }
    return context.json({
      forks: await manager.listExperimentForks(context.req.param("id")),
    });
  });

  app.post("/api/sessions/:id/forks", async (context) => {
    const target = await resolveProject(context);
    const manager = target.sessionManager;
    if (!manager) return context.json({ error: "会话服务未启用" }, 503);
    const parentSessionId = context.req.param("id");
    if (!manager.get(parentSessionId)) {
      return context.json({ error: "父会话不存在" }, 404);
    }
    try {
      const body = (await context.req.json()) as {
        turnId?: unknown;
        providerId?: unknown;
        model?: unknown;
        systemPromptOverlay?: unknown;
        continuation?: unknown;
      };
      if (
        typeof body.turnId !== "string" ||
        !body.turnId.trim() ||
        typeof body.continuation !== "string" ||
        !body.continuation.trim()
      ) {
        return context.json(
          { error: "turnId 与 continuation 不能为空" },
          400,
        );
      }
      const hasProvider = typeof body.providerId === "string" && body.providerId.trim();
      const hasModel = typeof body.model === "string" && body.model.trim();
      if (Boolean(hasProvider) !== Boolean(hasModel)) {
        return context.json(
          { error: "providerId 与 model 必须同时提供" },
          400,
        );
      }
      const session = await manager.createExperimentFork({
        parentSessionId,
        turnId: body.turnId.trim(),
        continuation: body.continuation.trim(),
        ...(hasProvider && hasModel
          ? {
              model: {
                providerId: String(body.providerId).trim(),
                model: String(body.model).trim(),
              },
            }
          : {}),
        ...(typeof body.systemPromptOverlay === "string" &&
        body.systemPromptOverlay.trim()
          ? { systemPromptOverlay: body.systemPromptOverlay.trim() }
          : {}),
      });
      const info = await manager.experimentForkInfo(session.id);
      return context.json(
        {
          session: session.summary(),
          ...(info ? { experiment: info.experiment, workspace: info.workspace } : {}),
        },
        201,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "创建实验 Fork 失败";
      return context.json(
        { error: message },
        message.includes("运行中") ? 409 : 400,
      );
    }
  });

  app.get("/api/sessions/:childId/diff", async (context) => {
    const target = await resolveProject(context);
    const manager = target.sessionManager;
    if (!manager) return context.json({ error: "会话服务未启用" }, 503);
    try {
      const comparison = await manager.experimentDiff(
        context.req.param("childId"),
      );
      return context.json({ comparison: redactTrace(comparison) });
    } catch (error) {
      return context.json(
        { error: error instanceof Error ? error.message : "对比失败" },
        404,
      );
    }
  });

  // Flight Recorder: list lightweight metadata by default; details are loaded
  // separately so the session view does not transfer full prompts/tool output.
  app.get("/api/sessions/:id/traces", async (context) => {
    const target = await resolveProject(context);
    const session = target.sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    const traces = await session.traces();
    const pinned = session.summary?.().experiment?.pinnedModel;
    return context.json({
      traces: traces.map((trace) => {
        const tools = Array.isArray(trace.tools) ? trace.tools : [];
        // The list is a lightweight card endpoint, but observation still
        // contains short user/model previews. Derive it from the redacted
        // payload so those previews cannot bypass the trace boundary.
        const observation = observeTurn(redactTrace(trace));
        const providerId = trace.providerId ?? pinned?.providerId;
        const model = trace.model ?? pinned?.model;
        return {
          version: trace.version,
          turn: trace.turn,
          turnId: trace.turnId,
          branchId: trace.branchId,
          ts: trace.ts,
          startedAt: trace.startedAt,
          endedAt: trace.endedAt,
          durationMs: trace.durationMs,
          eventSeqStart: trace.eventSeqStart,
          eventSeqEnd: trace.eventSeqEnd,
          modelRole: trace.modelRole,
          ...(providerId ? { providerId } : {}),
          ...(model ? { model } : {}),
          usage: trace.usage,
          toolCount: tools.length,
          tools: tools.map((tool) => ({
            tool: tool.call.tool,
            permission: tool.permission,
            ms: tool.ms,
          })),
          observation: {
            saw: observation.saw,
            decided: observation.decided,
            did: observation.did,
          },
          ...(trace.workspace ? { workspace: trace.workspace } : {}),
          // Legacy records have no event range and cannot safely be forked.
          canFork:
            trace.version === 2 &&
            typeof trace.turnId === "string" &&
            trace.modelRole === "main" &&
            typeof trace.eventSeqStart === "number" &&
            typeof trace.eventSeqEnd === "number" &&
            trace.eventSeqEnd > trace.eventSeqStart,
        };
      }),
    });
  });

  app.get("/api/sessions/:id/traces/:turnId", async (context) => {
    const target = await resolveProject(context);
    const session = target.sessionManager?.get(context.req.param("id"));
    if (!session) return context.json({ error: "会话不存在" }, 404);
    const trace = (await session.traces()).find(
      (item) => item.turnId === context.req.param("turnId"),
    );
    if (!trace) return context.json({ error: "Trace 不存在" }, 404);
    const requestedView = context.req.query("view");
    if (requestedView && requestedView !== "raw" && requestedView !== "redacted") {
      return context.json({ error: "view 必须是 raw 或 redacted" }, 400);
    }
    const view = requestedView ?? "redacted";
    const payload = view === "raw" ? trace : redactTrace(trace);
    // Raw is intentionally opt-in; no raw payload is cached by this route.
    return context.json({
      trace: payload,
      observation: observeTurn(payload),
      redacted: view !== "raw",
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
}
