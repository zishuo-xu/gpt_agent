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
 */

export interface ProjectEntry {
  /** 项目标识（base64url(cwd)），作为 ?project= 参数 */
  key: string;
  name: string;
  cwd: string;
  updatedAt?: string;
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
    this.#stateDir = options.stateDir ?? path.join(os.homedir(), ".myagent");
    this.#homeDir = options.homeDir ?? os.homedir();
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

  /** 按 cwd 获取（并缓存）该项目的资源。 */
  async getByCwd(cwd: string): Promise<ProjectResources> {
    const cached = this.#cache.get(cwd);
    if (cached) return cached;
    const configService = new ConfigService({ cwd, homeDir: this.#homeDir });
    const sessionManager = new WebSessionManager(cwd, configService);
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
    if (!key || key === ProjectRegistry.projectKey(this.#defaultCwd)) {
      return { cwd: this.#defaultCwd, resources: await this.getByCwd(this.#defaultCwd) };
    }
    const projects = await this.listProjects();
    const found = projects.find((entry) => entry.key === key);
    const cwd = found?.cwd ?? this.#defaultCwd;
    return { cwd, resources: await this.getByCwd(cwd) };
  }
}
