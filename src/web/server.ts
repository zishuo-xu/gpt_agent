import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { ConfigService } from "../config/service.js";
import { createWebApp } from "./app.js";
import { WebSessionManager } from "./sessions.js";

export interface WebServerOptions {
  cwd: string;
  hostname?: string;
  port?: number;
}

export async function startWebServer(options: WebServerOptions): Promise<void> {
  const configService = new ConfigService({ cwd: options.cwd });
  const config = await configService.readEffective();
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
  const app = createWebApp(configService, sessionManager);

  // 认证中间件：非 localhost 监听时校验密码
  if (needsAuth) {
    const AUTH_COOKIE = "myagent_auth";
    const authToken = Buffer.from(password).toString("base64url");

    app.use("*", async (context, next) => {
      // 登录端点不需要认证
      if (context.req.path === "/api/auth") return await next();

      const cookie = context.req.header("cookie") ?? "";
      const match = cookie.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`));
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

  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));

  app.use("/assets/*", serveStatic({ root: webRoot }));
  app.get("*", serveStatic({ path: `${webRoot}/index.html` }));

  serve({ fetch: app.fetch, hostname: effectiveHostname, port }, (info) => {
    process.stdout.write(
      `\n◆ MyAgent Web 已启动\n  http://${info.address}:${info.port}${needsAuth ? "（已启用密码保护）" : ""}\n  按 Ctrl+C 停止。\n\n`,
    );
  });
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
