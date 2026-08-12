import type { ConfigService } from "../config/service.js";
import type { MemoryService } from "./memory.js";
import type { ProjectRegistry } from "./project-registry.js";
import type { SchedulerHub } from "./scheduler-hub.js";
import type { WebSessionManager } from "./sessions.js";

/** 解析请求指向的项目资源（未传 project 时用启动目录项目，向后兼容） */
export interface ResolvedProject {
  configService: ConfigService;
  /** 无会话管理器（未启用 Web 会话服务）时为 undefined，调用方需防御 */
  sessionManager: WebSessionManager | undefined;
  memoryService: MemoryService;
}

/**
 * 业务路由共享依赖：createWebApp 组装后注入各路由注册函数。
 * resolveProject 保持 app.ts 中的闭包语义（默认单例 + 多项目注册表解析）。
 */
export interface WebRouteDeps {
  resolveProject: (context: {
    req: { query: (k: string) => string | undefined };
  }) => Promise<ResolvedProject>;
  registry: ProjectRegistry;
  schedulerHub?: SchedulerHub;
}
