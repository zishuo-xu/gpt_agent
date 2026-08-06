import { mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigService } from "../config/service.js";
import { WebSessionManager } from "./sessions.js";

/**
 * 多项目注册表。
 *
 * 一个 Web 进程默认只服务启动目录（cwd）这一个项目。本模块把项目维度的
 * 资源（ConfigService / WebSessionManager / 记忆服务 cwd）做成"按项目缓存"，
 * 让同一个 Web 界面可以在多个项目之间切换。
 *
 * 项目数据源：~/.myagent/projects/<base64url(cwd)>/project.json
 * （由 AgentSessionManager.#ensureProjectMetadata 在会话创建时写入）。
 *
 * 特殊项目「大厅」（key = "lobby"）：不绑定任何真实目录，会话只读不写，
 * 用于"不操作任何文件"的纯问答场景。
 */

/** 大厅项目的合成 key（与 base64url 格式区分，避免与真实 cwd 撞 key）。 */
export const LOBBY_KEY = "lobby";

export interface ProjectEntry {
  /** 项目标识（base64url(cwd)），作为 ?project= 参数；大厅为 "lobby" */
  key: string;
  name: string;
  cwd: string;
  updatedAt?: string;
  /** 大厅项目标记 */
  lobby?: boolean;
}

export interface ProjectResources {
  configService: ConfigService;
  sessionManager: WebSessionManager;
}

export class ProjectRegistry {
  readonly #stateDir: string;
  readonly #homeDir: string;
  readonly #defaultCwd: string;
  readonly #cache = new Map<string, ProjectResources>();

  constructor(options: { defaultCwd: string; stateDir?: string; homeDir?: string }) {
    this.#defaultCwd = options.defaultCwd;
    this.#homeDir = options.homeDir ?? os.homedir();
    // stateDir 默认与 homeDir 对齐（生产 os.homedir()/.myagent；测试可传 tmp 隔离）
    this.#stateDir =
      options.stateDir ?? path.join(this.#homeDir, ".myagent");
  }

  get defaultCwd(): string {
    return this.#defaultCwd;
  }

  static projectKey(cwd: string): string {
    return Buffer.from(cwd).toString("base64url");
  }

  /** 列出所有已知项目（含启动目录项目，即使尚无会话）。 */
  async listProjects(): Promise<ProjectEntry[]> {
    const projectsDir = path.join(this.#stateDir, "projects");
    const byCwd = new Map<string, ProjectEntry>();

    // 启动目录项目总是可用
    byCwd.set(this.#defaultCwd, {
      key: ProjectRegistry.projectKey(this.#defaultCwd),
      name: path.basename(this.#defaultCwd),
      cwd: this.#defaultCwd,
    });

    let keys: string[] = [];
    try {
      keys = (await readdir(projectsDir)).filter(
        (entry) => !entry.startsWith("."),
      );
    } catch {
      keys = [];
    }
    const lobbyCwd = this.lobbyCwd();
    for (const key of keys) {
      try {
        const raw = await readFile(
          path.join(projectsDir, key, "project.json"),
          "utf8",
        );
        const meta = JSON.parse(raw) as {
          name?: string;
          cwd?: string;
          updatedAt?: string;
        };
        if (typeof meta.cwd !== "string" || !meta.cwd) continue;
        // 大厅是合成项目（key=lobby），其真实临时目录不重复列出
        if (meta.cwd === lobbyCwd) continue;
        byCwd.set(meta.cwd, {
          key,
          name: meta.name ?? path.basename(meta.cwd),
          cwd: meta.cwd,
          ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : {}),
        });
      } catch {
        continue;
      }
    }
    return [...byCwd.values()].sort((a, b) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
  }

  /** 大厅项目的固定 cwd（专用临时目录，不触碰任何用户目录）。 */
  lobbyCwd(): string {
    return path.join(os.tmpdir(), "myagent-lobby");
  }

  /**
   * 注册外部已创建的默认项目实例（server.ts 启动主 manager 时调用）：
   * 主实例与 registry 缓存共享同一写锁，避免同项目双实例并发 restore 撞锁。
   */
  seed(
    cwd: string,
    configService: ConfigService,
    sessionManager: WebSessionManager,
  ): void {
    this.#cache.set(cwd, { configService, sessionManager });
  }

  /** 大厅项目（只读不写），始终可用。 */
  async getLobby(): Promise<ProjectResources> {
    const cwd = this.lobbyCwd();
    const cached = this.#cache.get(cwd);
    if (cached) return cached;
    // 大厅 cwd 是专用临时目录：确保存在（工具的工作目录依赖它），只读规则仍阻止写文件
    mkdirSync(cwd, { recursive: true });
    const configService = new ConfigService({
      cwd,
      homeDir: this.#homeDir,
    });
    const sessionManager = new WebSessionManager(cwd, configService, {
      lobby: true,
      stateDir: this.#stateDir,
    });
    await sessionManager.restore();
    const resources: ProjectResources = { configService, sessionManager };
    this.#cache.set(cwd, resources);
    return resources;
  }

  /** 按 cwd 获取（并缓存）该项目的资源。 */
  async getByCwd(cwd: string): Promise<ProjectResources> {
    const cached = this.#cache.get(cwd);
    if (cached) return cached;
    const configService = new ConfigService({ cwd, homeDir: this.#homeDir });
    const sessionManager = new WebSessionManager(cwd, configService, {
      stateDir: this.#stateDir,
    });
    await sessionManager.restore();
    const resources: ProjectResources = { configService, sessionManager };
    this.#cache.set(cwd, resources);
    return resources;
  }

  /** 按项目 key（?project=）解析资源；未知 key 回退启动目录项目。 */
  async resolve(projectKey?: string): Promise<{
    cwd: string;
    resources: ProjectResources;
  }> {
    const key = projectKey?.trim();
    if (key === LOBBY_KEY) {
      return {
        cwd: this.lobbyCwd(),
        resources: await this.getLobby(),
      };
    }
    if (!key || key === ProjectRegistry.projectKey(this.#defaultCwd)) {
      return { cwd: this.#defaultCwd, resources: await this.getByCwd(this.#defaultCwd) };
    }
    const projects = await this.listProjects();
    const found = projects.find((entry) => entry.key === key);
    const cwd = found?.cwd ?? this.#defaultCwd;
    return { cwd, resources: await this.getByCwd(cwd) };
  }

  /** 释放全部已缓存项目实例的单实例写锁（进程优雅退出路径调用）。 */
  async disposeAll(): Promise<void> {
    const managers = [...this.#cache.values()].map(
      (resources) => resources.sessionManager,
    );
    await Promise.all(
      managers.map((manager) => manager.releaseLock()),
    );
    this.#cache.clear();
  }
}
