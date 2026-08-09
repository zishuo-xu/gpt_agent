import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
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
