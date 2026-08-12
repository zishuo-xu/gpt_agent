import { Hono } from "hono";
import type { ConfigService } from "../config/service.js";
import { MemoryService } from "./memory.js";
import { ProjectRegistry } from "./project-registry.js";
import { SchedulerHub } from "./scheduler-hub.js";
import { registerConfigRoutes } from "./routes-config.js";
import type { ResolvedProject, WebRouteDeps } from "./routes-context.js";
import { registerMiscRoutes } from "./routes-misc.js";
import { registerProjectRoutes } from "./routes-projects.js";
import { registerScheduledRoutes } from "./routes-scheduled.js";
import { registerSessionRoutes } from "./routes-sessions.js";
import type { WebSessionManager } from "./sessions.js";

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
  }): Promise<ResolvedProject> {
    const key = context.req.query("project");
    if (!key) {
      // 未指定项目：默认（启动目录）单例
      if (!sessionManager) {
        return {
          configService,
          sessionManager: undefined,
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

  const deps: WebRouteDeps = {
    resolveProject,
    registry,
    ...(schedulerHub ? { schedulerHub } : {}),
  };
  registerProjectRoutes(app, deps);
  registerConfigRoutes(app, deps);
  registerSessionRoutes(app, deps);
  registerMiscRoutes(app, deps);
  registerScheduledRoutes(app, deps);

  // 挂载注册表引用：进程优雅退出时释放全部项目写锁（server.ts 信号处理使用）
  return Object.assign(app, { registry });
}
