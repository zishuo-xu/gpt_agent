import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigService } from "../config/service.js";
import { createWebApp } from "./app.js";
import { WebSessionManager } from "./sessions.js";
import { SchedulerHub } from "./scheduler-hub.js";
import { ProjectRegistry } from "./project-registry.js";
import { localDay } from "./stats.js";

export interface WebServerOptions {
  cwd: string;
  hostname?: string;
  port?: number;
}

export async function startWebServer(options: WebServerOptions): Promise<void> {
  const { timingMark, timingReport } = await import("../utils/timing.js");
  const configService = new ConfigService({ cwd: options.cwd });
  // 启动时清理过期超限落盘日志（尽力而为，不阻塞启动）
  const { cleanupStaleBashLogs } = await import("../tools/bash.js");
  void cleanupStaleBashLogs();
  const config = await configService.readEffective();
  timingMark("config 加载");
  const serverConfig = config.server ?? { host: "127.0.0.1", password: "" };
  const hostname = options.hostname ?? serverConfig.host ?? "127.0.0.1";
  const isLocalhost = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  const password = serverConfig.password?.trim() ?? "";

  if (!isLocalhost && !password) {
    process.stderr.write(
      "⚠ 监听非 localhost 地址时必须配置访问密码（server.password）。已回退到 127.0.0.1。\n",
    );
  }
  const effectiveHostname = !isLocalhost && !password ? "127.0.0.1" : hostname;
  const needsAuth = !isLocalhost && !!password;

  const preferredPort = options.port ?? 3000;
  const port = await findAvailablePort(effectiveHostname, preferredPort);
  const sessionManager = new WebSessionManager(options.cwd, configService);
  await sessionManager.restore();
  timingMark("restore");

  // 启动即加载插件（幂等）：插件面板立即可见 loaded/errors，不等到首个模型请求。
  // 失败不阻塞启动——加载错误进入 pluginStatus().errors 由面板展示。
  try {
    await sessionManager.ensurePluginsLoaded();
  } catch (error) {
    process.stderr.write(
      `[plugins] 启动加载失败（面板可见错误详情）：${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }

  // 定时 /run 调度器：与 app 共享（ticker + API 同一实例），默认项目启动即加载
  const schedulerHub = new SchedulerHub(
    path.join(configService.homeDir, ".myagent"),
  );
  await schedulerHub.ensureLoaded(
    ProjectRegistry.projectKey(options.cwd),
  );

  // 认证中间件：非 localhost 监听时校验密码。
  // 必须通过 mountBeforeRoutes 在业务路由之前注册——Hono 按注册顺序执行中间件，
  // 若在 createWebApp 之后 app.use("*")，已注册的 /api/* 路由会先命中而不受保护。
  // 主 manager 与 registry 共享同一项目写锁：注册为默认项目实例，
  // 避免 resolve 默认项目时创建第二个实例并发 restore 撞锁
  const app = createWebApp(
    configService,
    sessionManager,
    needsAuth
      ? (app) => {
          const AUTH_COOKIE = "myagent_auth";
          const authToken = Buffer.from(password).toString("base64url");

          app.use("*", async (context, next) => {
            // 登录端点不需要认证
            if (context.req.path === "/api/auth") return await next();

            const cookie = context.req.header("cookie") ?? "";
            const match = cookie.match(
              new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`),
            );
            if (match?.[1] === authToken) return await next();

            // API 请求返回 401
            if (context.req.path.startsWith("/api/")) {
              return context.json({ error: "未授权", requiresAuth: true }, 401);
            }
            // 页面请求返回登录页
            return context.html(loginPage(), 200);
          });

          app.post("/api/auth", async (context) => {
            const body = (await context.req.json()) as { password?: string };
            if (body.password !== password) {
              return context.json({ ok: false, error: "密码错误" }, 401);
            }
            const headers = new Headers();
            headers.append(
              "set-cookie",
              `${AUTH_COOKIE}=${authToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 24 * 3600}`,
            );
            return context.json({ ok: true }, { headers });
          });
        }
      : undefined,
    schedulerHub,
  );
  // 主实例注册进 registry（共享锁），disposeAll 也会释放主实例的锁
  app.registry.seed(options.cwd, configService, sessionManager);

  // /api/v1 无头接口：Bearer token 认证，供飞书机器人等外部系统集成。
  // apiToken 未配置时认证中间件返回 404 not_enabled（接口整体未启用）。
  const { createApiV1 } = await import("./api-v1.js");
  app.route(
    "/api/v1",
    createApiV1({
      apiToken: serverConfig.apiToken?.trim() ?? "",
      registry: app.registry,
      configService,
      sessionManager,
    }),
  );

  // 每 30s 轮询到期任务：解析到目标项目的 sessionManager 后按 /run 路径启动会话。
  // 无人值守场景下 hardRules（deny 规则）由权限引擎强制，无需交互确认，直接放行。
  // onDue 返回 false 表示预算护栏拒绝（调度器顺延，不视为失败）。
  const schedulerTicker = setInterval(() => {
    void schedulerHub.tick(new Date(), async (projectKey, task) => {
      const runtimeConfig = await configService.readEffective();
      const dailyCap = runtimeConfig.behavior.dailyBudgetCny ?? 0;
      const { resources } = await app.registry.resolve(projectKey);
      if (dailyCap > 0) {
        const todayCost = resources.sessionManager
          .list()
          .filter((summary) => localDay(summary.createdAt) === localDay(new Date().toISOString()))
          .reduce((sum, summary) => sum + summary.totalCostCny, 0);
        if (todayCost >= dailyCap) {
          process.stdout.write(
            `[scheduler] 今日费用 ¥${todayCost.toFixed(2)} 已达上限 ¥${dailyCap.toFixed(2)}，定时任务 ${task.id} 顺延\n`,
          );
          return false;
        }
      }
      const session = await resources.sessionManager.create(
        task.command,
        task.options.permission ?? "normal",
      );
      process.stdout.write(
        `[scheduler] 定时任务 ${task.id} 已启动会话 ${session.id}（${session.title}）\n`,
      );
      return session.id;
    });
  }, 30_000);
  schedulerTicker.unref();

  // 保留策略：启动时清理一次 + 每日清理（behavior.sessionRetentionDays，0 = 关闭）。
  // 清理按 updatedAt 判定，运行中/等待审批的会话跳过。
  const purgeTicker = setInterval(() => {
    void purgeExpiredSessions();
  }, 24 * 3600_000);
  purgeTicker.unref();

  async function purgeExpiredSessions(): Promise<void> {
    const runtimeConfig = await configService.readEffective();
    const days = runtimeConfig.behavior.sessionRetentionDays ?? 30;
    if (days <= 0) return;
    const purged = await sessionManager.purgeOldSessions(days);
    if (purged > 0) {
      process.stdout.write(
        `[retention] 已清理 ${purged} 个超过 ${days} 天未更新的会话\n`,
      );
    }
  }
  await purgeExpiredSessions();

  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));

  app.use("/assets/*", serveStatic({ root: webRoot }));
  app.get("*", serveStatic({ path: `${webRoot}/index.html` }));

  serve({ fetch: app.fetch, hostname: effectiveHostname, port }, (info) => {
    process.stdout.write(
      `\n◆ MyAgent Web 已启动\n  http://${info.address}:${info.port}${needsAuth ? "（已启用密码保护）" : ""}\n  按 Ctrl+C 停止。\n\n`,
    );
    process.stderr.write(timingReport());
  });

  // 优雅关闭：flush 尾部事件（不丢写盘）+ 释放全部项目单实例写锁 + 清理 MCP 子进程
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(schedulerTicker);
    clearInterval(purgeTicker);
    await sessionManager.flush();
    await sessionManager.releaseLock();
    await sessionManager.closeMcp();
    await app.registry.disposeAll();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function loginPage(): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MyAgent — 登录</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5}
form{background:#1a1a1a;padding:2rem;border-radius:12px;width:320px;text-align:center}
h1{font-size:1.25rem;margin-bottom:1.5rem}
input{width:100%;padding:.75rem;border:1px solid #333;border-radius:8px;background:#111;color:#e5e5e5;font-size:1rem;margin-bottom:1rem;box-sizing:border-box}
button{width:100%;padding:.75rem;border:none;border-radius:8px;background:#3b82f6;color:#fff;font-size:1rem;cursor:pointer}
button:hover{background:#2563eb}
.error{color:#ef4444;font-size:.875rem;margin-top:.5rem;min-height:1.25rem}</style></head>
<body><form id="f"><h1>MyAgent</h1><input type="password" id="p" placeholder="访问密码" autofocus><button type="submit">进入</button><div class="error" id="e"></div></form>
<script>document.getElementById("f").addEventListener("submit",async(e)=>{e.preventDefault();const r=await fetch("/api/auth",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("p").value})});if(r.ok){location.reload()}else{document.getElementById("e").textContent="密码错误"}})</script></body></html>`;
}

async function findAvailablePort(
  hostname: string,
  preferredPort: number,
): Promise<number> {
  for (let port = preferredPort; port < preferredPort + 20; port += 1) {
    if (await canListen(hostname, port)) return port;
  }
  throw new Error(`端口 ${preferredPort}-${preferredPort + 19} 均被占用`);
}

async function canListen(hostname: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, hostname, () => {
      probe.close(() => resolve(true));
    });
  });
}
