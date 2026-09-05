import { existsSync, mkdirSync } from "node:fs";
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
  /** 加载中的项目（cwd → promise）：并发首触共享同一加载，避免重复实例撞项目写锁 */
  readonly #loading = new Map<string, Promise<ProjectResources>>();

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
        // 目录已删除的残留项目（e2e/临时目录清理后 project.json 仍在）不再列出，
        // 否则幽灵项目会淹没项目切换器（同名 basename 无法区分）
        if (!existsSync(meta.cwd)) continue;
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
  getLobby(): Promise<ProjectResources> {
    return this.#loadProject(this.lobbyCwd(), { lobby: true });
  }

  /** 按 cwd 获取（并缓存）该项目的资源。 */
  getByCwd(cwd: string): Promise<ProjectResources> {
    return this.#loadProject(cwd);
  }

  /**
   * 按需加载项目资源：缓存命中直接返回；加载中并发复用同一 promise。
   * 前端切项目时会并发请求多个接口，若各自创建实例并 restore，
   * 项目单实例写锁会把后到者判为"同进程占用"，整批请求报错。
   */
  #loadProject(
    cwd: string,
    options: { lobby?: boolean } = {},
  ): Promise<ProjectResources> {
    const cached = this.#cache.get(cwd);
    if (cached) return Promise.resolve(cached);
    const inflight = this.#loading.get(cwd);
    if (inflight) return inflight;
    const load = this.#createResources(cwd, options.lobby === true)
      .then((resources) => {
        this.#cache.set(cwd, resources);
        return resources;
      })
      .finally(() => {
        this.#loading.delete(cwd);
      });
    this.#loading.set(cwd, load);
    return load;
  }

  async #createResources(
    cwd: string,
    lobby: boolean,
  ): Promise<ProjectResources> {
    if (lobby) {
      // 大厅 cwd 是专用临时目录：确保存在（工具的工作目录依赖它），只读规则仍阻止写文件
      mkdirSync(cwd, { recursive: true });
    }
    const configService = new ConfigService({ cwd, homeDir: this.#homeDir });
    const sessionManager = new WebSessionManager(cwd, configService, {
      ...(lobby ? { lobby: true } : {}),
      stateDir: this.#stateDir,
    });
    try {
      await sessionManager.restore();
    } catch (error) {
      // 首触失败须释放已取得的写锁：锁残留的持有者是本进程（存活），
      // 后续加载会一直报"项目已被占用"，只能重启自愈
      await sessionManager.releaseLock().catch(() => undefined);
      throw error;
    }
    return { configService, sessionManager };
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
