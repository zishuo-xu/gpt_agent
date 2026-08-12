import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { AgentEvent, RecordedEvent } from "../core/types.js";
import type { ConfigService } from "../config/service.js";
import { parseRunCommand } from "../core/run-task.js";
import { exportSessionHtml } from "./export-session.js";
import type { ProjectRegistry } from "./project-registry.js";
import type { WebSessionManager } from "./sessions.js";

export interface ApiV1Options {
  /** Bearer token；空串 = 接口未启用（404 not_enabled） */
  apiToken: string;
  registry: ProjectRegistry;
  configService: ConfigService;
  sessionManager?: WebSessionManager;
}

/**
 * /api/v1 无头接口（飞书机器人等外部系统集成用）：
 * 同进程薄路由层，只调 WebSessionManager/AgentSession 公共方法，核心零改动。
 * 白名单事件契约见 mapV1Events；未知事件折叠 system.info，契约永不破。
 */
export function createApiV1(options: ApiV1Options): Hono {
  const app = new Hono();

  app.use("*", async (context, next) => {
    if (!options.apiToken) {
      return context.json(
        {
          ok: false,
          error: "接口未启用（server.apiToken 未配置）",
          code: "not_enabled",
        },
        404,
      );
    }
    const match = /^Bearer\s+(.+)$/i.exec(
      context.req.header("authorization") ?? "",
    );
    const token = match?.[1] ?? "";
    if (!token || !safeEqual(token, options.apiToken)) {
      return context.json(
        { ok: false, error: "未授权", code: "unauthorized" },
        401,
      );
    }
    return next();
  });

  async function resolveV1Project(context: {
    req: { query: (k: string) => string | undefined };
  }): Promise<{
    configService: ConfigService;
    sessionManager: WebSessionManager | undefined;
  }> {
    const key = context.req.query("project");
    if (!key) {
      return {
        configService: options.configService,
        sessionManager: options.sessionManager,
      };
    }
    const { resources } = await options.registry.resolve(key);
    return {
      configService: resources.configService,
      sessionManager: resources.sessionManager,
    };
  }

  app.get("/sessions", async (context) => {
    const { sessionManager } = await resolveV1Project(context);
    if (!sessionManager) {
      return context.json(
        { ok: false, error: "默认项目未加载", code: "not_found" },
        404,
      );
    }
    const limit = Math.max(
      1,
      Math.min(Number(context.req.query("limit")) || 20, 200),
    );
    return context.json({ ok: true, data: sessionManager.list().slice(0, limit) });
  });

  app.get("/sessions/:id", async (context) => {
    const { sessionManager } = await resolveV1Project(context);
    const session = sessionManager?.get(context.req.param("id"));
    if (!session) {
      return context.json({ ok: false, error: "会话不存在", code: "not_found" }, 404);
    }
    return context.json({ ok: true, data: session.summary() });
  });

  app.get("/sessions/:id/events", async (context) => {
    const { sessionManager } = await resolveV1Project(context);
    const session = sessionManager?.get(context.req.param("id"));
    if (!session) {
      return context.json({ ok: false, error: "会话不存在", code: "not_found" }, 404);
    }
    const rawAfter = Number(context.req.query("after"));
    const after = Number.isFinite(rawAfter) && rawAfter >= 0 ? rawAfter : 0;
    const records = session.events(after);
    return context.json({
      ok: true,
      data: {
        events: mapV1Events(records),
        latestSeq:
          records.length > 0 ? records[records.length - 1]!.seq : after,
      },
    });
  });

  app.get("/sessions/:id/export", async (context) => {
    const { sessionManager } = await resolveV1Project(context);
    const session = sessionManager?.get(context.req.param("id"));
    if (!session) {
      return context.json({ ok: false, error: "会话不存在", code: "not_found" }, 404);
    }
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

  app.post("/runs", async (context) => {
    const { sessionManager } = await resolveV1Project(context);
    if (!sessionManager) {
      return context.json(
        { ok: false, error: "默认项目未加载", code: "not_found" },
        404,
      );
    }
    let body: { command?: unknown; confirmBounds?: unknown };
    try {
      body = (await context.req.json()) as typeof body;
    } catch {
      return context.json(
        { ok: false, error: "请求体需为 JSON", code: "invalid" },
        400,
      );
    }
    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!command.startsWith("/run")) {
      return context.json(
        { ok: false, error: "command 需为 /run 任务命令", code: "invalid" },
        400,
      );
    }
    const run = parseRunCommand(command);
    if (run.hardRules.length > 0 && body.confirmBounds !== true) {
      return context.json(
        {
          ok: false,
          error: "需要先确认任务硬边界（confirmBounds: true）",
          code: "conflict",
          data: { hardRules: run.hardRules, semanticBounds: run.semanticBounds },
        },
        409,
      );
    }
    const session = await sessionManager.create(
      command,
      run.permission ?? "normal",
    );
    return context.json({ ok: true, data: { sessionId: session.id } });
  });

  app.post("/sessions/:id/messages", async (context) => {
    const { sessionManager } = await resolveV1Project(context);
    const session = sessionManager?.get(context.req.param("id"));
    if (!session) {
      return context.json({ ok: false, error: "会话不存在", code: "not_found" }, 404);
    }
    let body: { message?: unknown; steer?: unknown };
    try {
      body = (await context.req.json()) as typeof body;
    } catch {
      return context.json(
        { ok: false, error: "请求体需为 JSON", code: "invalid" },
        400,
      );
    }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return context.json(
        { ok: false, error: "消息不能为空", code: "invalid" },
        400,
      );
    }
    if (message.startsWith("/run")) {
      return context.json(
        { ok: false, error: "任务发起请用 POST /api/v1/runs", code: "invalid" },
        400,
      );
    }
    const queued = session.isProcessing();
    void session.sendInput(
      message,
      undefined,
      body.steer === true ? { steer: true } : undefined,
    );
    return context.json({ ok: true, data: { accepted: true, queued } });
  });

  app.post("/sessions/:id/approvals/:callId", async (context) => {
    const { sessionManager } = await resolveV1Project(context);
    const session = sessionManager?.get(context.req.param("id"));
    if (!session) {
      return context.json({ ok: false, error: "会话不存在", code: "not_found" }, 404);
    }
    let body: { granted?: unknown; scope?: unknown; feedback?: unknown };
    try {
      body = (await context.req.json()) as typeof body;
    } catch {
      return context.json(
        { ok: false, error: "请求体需为 JSON", code: "invalid" },
        400,
      );
    }
    if (typeof body.granted !== "boolean") {
      return context.json(
        { ok: false, error: "granted 需为布尔值", code: "invalid" },
        400,
      );
    }
    const resolved = session.resolvePermission(
      context.req.param("callId"),
      {
        granted: body.granted,
        ...(typeof body.scope === "string"
          ? {
              scope: body.scope as "once" | "session" | "project" | "global",
            }
          : {}),
        ...(typeof body.feedback === "string" && body.feedback.trim()
          ? { feedback: body.feedback.trim() }
          : {}),
      },
    );
    if (!resolved) {
      return context.json(
        { ok: false, error: "审批已失效或不存在", code: "conflict" },
        409,
      );
    }
    return context.json({ ok: true, data: { resolved: true } });
  });

  app.post("/sessions/:id/interrupt", async (context) => {
    const { sessionManager } = await resolveV1Project(context);
    const session = sessionManager?.get(context.req.param("id"));
    if (!session) {
      return context.json({ ok: false, error: "会话不存在", code: "not_found" }, 404);
    }
    return session.interrupt()
      ? context.json({ ok: true, data: { interrupted: true } })
      : context.json(
          { ok: false, error: "会话当前未运行", code: "conflict" },
          409,
        );
  });

  return app;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export type V1Event =
  | { seq: number; ts: string; type: "user.text"; text: string }
  | { seq: number; ts: string; type: "assistant.text"; text: string }
  | { seq: number; ts: string; type: "assistant.thinking"; text: string }
  | { seq: number; ts: string; type: "tool.call"; tool: string; target?: string; args: unknown }
  | { seq: number; ts: string; type: "tool.result"; tool: string; summary: string; isError: boolean }
  | { seq: number; ts: string; type: "approval.request"; callId: string; tool: string; risk: string }
  | { seq: number; ts: string; type: "run.started"; description: string }
  | { seq: number; ts: string; type: "run.finished"; status: string; reason?: string }
  | {
      seq: number;
      ts: string;
      type: "ledger.update";
      taskId: string;
      unit: {
        id: string;
        kind: "file" | "task";
        label: string;
        status: string;
        note?: string;
      };
    }
  | { seq: number; ts: string; type: "system.info"; message: string }
  | { seq: number; ts: string; type: "system.error"; message: string };

/**
 * 内部事件 → v1 白名单契约（多对一折叠；未知类型永不破坏契约，折叠为 system.info）。
 * tool_result 的 tool 名依赖同流内前置 tool_call，跨批次增量拉取由调用方按需全量重扫。
 */
export function mapV1Events(records: RecordedEvent[]): V1Event[] {
  const toolNames = new Map<string, string>();
  const out: V1Event[] = [];
  for (const record of records) {
    out.push(mapV1Event(record, toolNames));
  }
  return out;
}

function mapV1Event(
  record: RecordedEvent,
  toolNames: Map<string, string>,
): V1Event {
  const base = { seq: record.seq, ts: record.ts };
  const event = record.event;
  switch (event.type) {
    case "user":
    case "user_queued":
      return { ...base, type: "user.text", text: event.text };
    case "text_delta":
      return { ...base, type: "assistant.text", text: event.text };
    case "thinking_delta":
      return { ...base, type: "assistant.thinking", text: event.text };
    case "tool_call": {
      toolNames.set(event.call.id, event.call.tool);
      return {
        ...base,
        type: "tool.call",
        tool: event.call.tool,
        ...(event.call.target ? { target: event.call.target } : {}),
        args: event.call.args ?? {},
      };
    }
    case "tool_result":
      return {
        ...base,
        type: "tool.result",
        tool: toolNames.get(event.callId) ?? "",
        summary: event.summary,
        isError: event.isError === true,
      };
    case "ask_permission":
      return {
        ...base,
        type: "approval.request",
        callId: event.call.id,
        tool: event.call.tool,
        risk: event.risk,
      };
    case "run_started":
      return { ...base, type: "run.started", description: event.description };
    case "run_finished":
      return {
        ...base,
        type: "run.finished",
        status: event.status,
        ...(event.reason ? { reason: event.reason } : {}),
      };
    case "ledger_update":
      return {
        ...base,
        type: "ledger.update",
        taskId: event.taskId,
        unit: {
          id: event.unit.id,
          kind: event.unit.kind,
          label: event.unit.label,
          status: event.unit.status,
          ...(event.unit.note ? { note: event.unit.note } : {}),
        },
      };
    case "error":
      return { ...base, type: "system.error", message: event.message };
    default:
      return { ...base, type: "system.info", message: systemInfoMessage(event) };
  }
}

function systemInfoMessage(event: AgentEvent): string {
  switch (event.type) {
    case "done":
      return "任务完成";
    case "need_user":
      return `需要用户：${event.question}`;
    case "notify":
      return event.message;
    case "interrupted":
      return `已中断（${event.scope}）`;
    case "permission_denied":
      return `权限拒绝：${event.call.tool} ${event.reason}`;
    case "branch_switch":
      return `切换分支 ${event.branchId}`;
    case "context_compacted":
      return `上下文已压缩（保留 #${event.keepFromSeq} 起）`;
    case "label":
      return event.name ? `书签 #${event.seq}「${event.name}」` : `移除书签 #${event.seq}`;
    case "session_info":
      return `会话标题：${event.name}`;
    case "permission_mode_changed":
      return `权限档 → ${event.mode}`;
    case "todo_update":
      return `任务清单（${event.todos.length} 项）`;
    case "cost_update":
      return `本轮 ${event.totalTokens} tokens${event.costCny ? ` / ¥${event.costCny}` : ""}`;
    case "model_fallback":
      return `模型降级：${event.from} → ${event.to}`;
    default:
      return JSON.stringify(event).slice(0, 200);
  }
}
