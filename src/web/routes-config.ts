import type { Hono } from "hono";
import {
  CONFIG_SCHEMA,
  toPublicConfig,
} from "../config/schema.js";
import {
  ConfigValidationError,
  type ConfigScope,
} from "../config/service.js";
import { testModelConnection } from "../model/test-connection.js";
import type { WebRouteDeps } from "./routes-context.js";

/** 配置路由：schema / 读写（global/project 双作用域）/ key 覆盖 / 连接测试 */
export function registerConfigRoutes(
  app: Hono,
  deps: WebRouteDeps,
): void {
  const { resolveProject } = deps;

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
}

function parseScope(value?: string): ConfigScope {
  return value === "project" ? "project" : "global";
}
