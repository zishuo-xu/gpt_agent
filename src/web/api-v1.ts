import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { AgentEvent, RecordedEvent } from "../core/types.js";
import type { ConfigService } from "../config/service.js";
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
