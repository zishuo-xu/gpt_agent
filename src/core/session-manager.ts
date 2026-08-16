import { randomUUID } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile, readJsonl } from "../utils/fs.js";
import type { ConfigService } from "../config/service.js";
import type { ModelRole } from "../config/schema.js";
import { DesktopNotifier, WebhookNotifier } from "./notifier.js";
import { pluginToolRegistry } from "../shared/plugin-tool.js";
import {
  loadPluginTools,
  savePluginDisabled,
  type PluginLoadReport,
} from "../tools/plugin-loader.js";
import {
  closeMcpClients,
  disposeMcpClientsSync,
  loadMcpServers,
} from "../tools/mcp-loader.js";
import type { McpClient } from "../tools/mcp-client.js";
import type { AtomicFileTools } from "../tools/atomic-file.js";
import { ConversationAgentModel } from "./agent-model.js";
import { FallbackModelClient } from "../model/fallback-client.js";
import type {
  ConversationMessage,
  ModelClient,
} from "../model/types.js";
import { ContextManager } from "./context.js";
import { DEFAULT_PERMISSION_RULES } from "./permissions.js";
import {
  AgentSession,
  type AgentSessionSummary,
} from "./session.js";
import {
  branchesFromEvents,
  conversationFrom,
  currentBranchIdFrom,
} from "./branch.js";
import type {
  PermissionMode,
  PermissionRule,
  RecordedEvent,
} from "./types.js";
import { acquireInstanceLock } from "./instance-lock.js";
import { buildRoleClientChain, rolePricing } from "./model-factory.js";
import { generateSessionTitle, titleFrom } from "./session-title.js";

export { buildRoleClientChain } from "./model-factory.js";

export interface AgentSessionManagerOptions {
  cwd: string;
  configService: ConfigService;
  stateDir?: string;
  homeDir?: string;
  /** 跳过单实例写锁（--force 语义）：多进程并发写同一项目事件流时数据损坏，非确知无残留不要用 */
  skipLock?: boolean;
  modelFactory?: (
    messages: ConversationMessage[],
  ) => Promise<ConversationAgentModel> | ConversationAgentModel;
  /** 文件工具实现（可注入记忆留档钩子等）；缺省每个会话新建 */
  files?: AtomicFileTools;
}

export class AgentSessionManager {
  readonly #cwd: string;
  readonly #configService: ConfigService;
  readonly #stateDir: string;
  readonly #homeDir: string;
  readonly #sessionsDir: string;
  readonly #projectDir: string;
  readonly #modelFactory:
    | AgentSessionManagerOptions["modelFactory"]
    | undefined;
  readonly #files: AtomicFileTools | undefined;
  readonly #sessions = new Map<string, AgentSession>();
  readonly #skipLock: boolean;
  #lockFile: string | undefined;
  #lockHeld = false;
  /** 进程级插件加载标记（首个模型构造前填充一次，运行中不刷新） */
  #pluginsLoaded = false;
  /** 插件加载报告（loaded + errors），供 /api/plugins 可观测性端点 */
  #pluginReport: PluginLoadReport = { loaded: [], errors: [] };
  /** 已连接的 MCP server 客户端（关闭/退出时统一清理） */
  readonly #mcpClients = new Map<string, McpClient>();

  constructor(options: AgentSessionManagerOptions) {
    this.#cwd = options.cwd;
    this.#configService = options.configService;
    this.#stateDir =
      options.stateDir ?? path.join(os.homedir(), ".myagent");
    this.#homeDir = options.homeDir ?? os.homedir();
    this.#modelFactory = options.modelFactory;
    this.#files = options.files;
    this.#skipLock = options.skipLock === true;
    const projectKey = Buffer.from(this.#cwd).toString("base64url");
    this.#projectDir = path.join(
      this.#stateDir,
      "projects",
      projectKey,
    );
    this.#sessionsDir = path.join(
      this.#projectDir,
      "sessions",
    );
    this.#configService.onChange((config) => {
      for (const session of this.#sessions.values()) {
        session.applyConfigChange(config);
      }
      // 重建模型客户端：API Key / 模型 / fallback 等配置变更即时生效
      void this.#refreshModelClients().catch(() => undefined);
    });
  }

  /** 首次触达项目目录时获取单实例写锁（幂等；restore/createSession 均会走到） */
  async #acquireLock(): Promise<void> {
    if (this.#lockHeld || this.#skipLock) return;
    this.#lockFile = path.join(this.#projectDir, "lock");
    await acquireInstanceLock(this.#lockFile, this.#skipLock);
    this.#lockHeld = true;
  }

  /** 释放写锁（进程正常退出路径调用；幂等） */
  async releaseLock(): Promise<void> {
    if (!this.#lockHeld || !this.#lockFile) return;
    this.#lockHeld = false;
    await unlink(this.#lockFile).catch(() => undefined);
  }

  /** 用最新配置重建三个角色客户端并替换到所有运行中会话 */
  async #refreshModelClients(): Promise<void> {
    const [main, compact, explore] = await Promise.all([
      this.#createRoleClient("main"),
      this.#createRoleClient("cheap"),
      this.#createRoleClient("explore"),
    ]);
    for (const session of this.#sessions.values()) {
      session.applyModelConfigChange({ main, compact, explore });
    }
  }

  list(): AgentSessionSummary[] {
    return [...this.#sessions.values()]
      .map((session) => session.summary())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 插件可观测性数据：加载报告 + 调用统计（供 /api/plugins） */
  pluginStatus(): {
    loaded: PluginLoadReport["loaded"];
    errors: PluginLoadReport["errors"];
    stats: ReturnType<typeof pluginToolRegistry.stats>;
    disabled: string[];
  } {
    return {
      loaded: this.#pluginReport.loaded,
      errors: this.#pluginReport.errors,
      stats: pluginToolRegistry.stats(),
      disabled: pluginToolRegistry
        .names()
        .filter((name) => !pluginToolRegistry.isEnabled(name)),
    };
  }

  /**
   * 启动时主动加载插件（幂等）：Web 服务 restore 后调用，让插件面板
   * 立即显示 loaded/errors，而非等到首个模型请求才惰性填充——消除
   * "无声失败"（dist 部署 + 未跑会话时面板空显示且无错误）。
   */
  async ensurePluginsLoaded(): Promise<void> {
    await this.#ensurePlugins();
  }

  /**
   * 单插件启用/禁用：registry 切换 + 持久化到全局 plugins.json（pluginDisabled 段），
   * 重启/reload 后保留。返回 false 表示插件未加载。
   */
  async pluginSetEnabled(name: string, enabled: boolean): Promise<boolean> {
    const ok = pluginToolRegistry.setEnabled(name, enabled);
    if (!ok) return false;
    await savePluginDisabled(this.#homeDir, name, enabled);
    return true;
  }

  get(id: string): AgentSession | undefined {
    return this.#sessions.get(id);
  }

  async deleteSession(id: string): Promise<boolean> {
    const session = this.#sessions.get(id);
    if (!session) return false;
    if (session.isProcessing()) {
      // 运行中的会话先硬中止，并等待工具轮结束（中断异步生效）；
      // 否则 tool_result(aborted) 会在 unlink 后落盘 → 文件被重建 → 会话"复活"
      session.interrupt();
      const deadline = Date.now() + 5_000;
      while (session.isProcessing() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    // 关闭写链：unlink 后残留事件（如中止中的工具结果）不再重建文件
    session.markClosed();
    this.#sessions.delete(id);
    await this.flush();
    for (const suffix of [".jsonl", ".trace.jsonl"]) {
      await unlink(path.join(this.#sessionsDir, `${id}${suffix}`)).catch(
        () => undefined,
      );
    }
    return true;
  }

  /**
   * 保留策略：清理超过 days 天未更新的历史会话（保留策略守卫，
   * 运行中/等待审批的会话跳过）。返回清理数量。
   */
  async purgeOldSessions(days: number): Promise<number> {
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = Date.now() - days * 86_400_000;
    let purged = 0;
    for (const summary of this.list()) {
      if (
        summary.status === "running" ||
        summary.status === "waiting_permission"
      ) {
        continue;
      }
      if (Date.parse(summary.updatedAt) < cutoff) {
        if (await this.deleteSession(summary.id)) purged += 1;
      }
    }
    return purged;
  }

  async restore(): Promise<void> {
    await this.#acquireLock();
    await this.#ensureProjectMetadata();
    let entries: string[];
    try {
      entries = (await readdir(this.#sessionsDir)).filter(
        (name) =>
          name.endsWith(".jsonl") &&
          !name.endsWith(".trace.jsonl"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (entries.length === 0) return;
    const runtimeConfig = await this.#configService.readEffective();

    for (const entry of entries) {
      const records = await readRecordedEvents(
        path.join(this.#sessionsDir, entry),
      );
      const firstUser = records.find(
        (record) => record.event.type === "user",
      );
      if (!firstUser || firstUser.event.type !== "user") continue;
      const id = entry.slice(0, -".jsonl".length);
      const compactModelClient =
        await this.#createRoleClient("cheap");
      const exploreModelClient =
        await this.#createRoleClient("explore");
      const branches = branchesFromEvents(records);
      const branchId = currentBranchIdFrom(records);
      const session = new AgentSession({
        id,
        title:
          sessionInfoTitle(records) ??
          titleFrom(firstUser.event.text),
        cwd: this.#cwd,
        mode:
          lastPermissionMode(records) ??
          runtimeConfig.permissions.mode,
        ...(this.#files ? { files: this.#files } : {}),
        // 恢复当前分支链视角的消息历史（分支点之前不变，之后只含当前分支）
        model: await this.#createModel(
          conversationFrom(records, branches, branchId),
          runtimeConfig.behavior?.crossProjectMemory !== false,
          runtimeConfig.behavior?.maxOutputTokens,
        ),
        stateDir: this.#stateDir,
        restoredEvents: records,
        permissionRules: [
          ...DEFAULT_PERMISSION_RULES,
          ...runtimeConfig.permissions.rules,
        ],
        approvalTimeoutMs:
          runtimeConfig.permissions.approvalTimeoutMs,
        rememberPermission: async (scope, rule) => {
          await this.#configService.addPermissionRule(scope, rule);
        },
        ...(compactModelClient
          ? { compactModelClient }
          : {}),
        ...(exploreModelClient
          ? { exploreModelClient }
          : {}),
        compactAtEstimatedTokens:
          runtimeConfig.context.compactAtEstimatedTokens,
        keepRecentTokens: runtimeConfig.context.keepRecentTokens,
        parallelTools: runtimeConfig.behavior?.parallelTools === true,
        completionReview:
          runtimeConfig.behavior?.completionReview ?? true,
        ...(runtimeConfig.behavior?.subagentTimeoutMs === undefined
          ? {}
          : { subagentTimeoutMs: runtimeConfig.behavior.subagentTimeoutMs }),
        pricing: rolePricing(runtimeConfig.models),
      });
      this.#register(session);
      // 恢复的会话同样注入推送（与 createSession 一致）：webhook + macOS 桌面通知
      if (runtimeConfig.notify.webhook) {
        new WebhookNotifier(
          (listener) =>
            session.subscribe((record) => listener(record.event)),
          {
            webhookUrl: runtimeConfig.notify.webhook,
            sessionTitle: session.title,
            getSummary: () => session.summary(),
          },
        );
      }
      if (runtimeConfig.notify.desktop === true) {
        new DesktopNotifier(
          (listener) =>
            session.subscribe((record) => listener(record.event)),
          {
            enabled: true,
            sessionTitle: session.title,
          },
        );
      }
    }
    await this.flush();
  }

  async createSession(options: {
    title?: string;
    mode?: PermissionMode;
    initialMessage?: string;
    /** 追加到默认+配置规则之上的权限规则（如大厅模式禁用文件写入） */
    extraPermissionRules?: PermissionRule[];
  } = {}): Promise<AgentSession> {
    await this.#acquireLock();
    await this.#ensureProjectMetadata();
    const message = options.initialMessage?.trim();
    const runtimeConfig = await this.#configService.readEffective();
    const compactModelClient =
      await this.#createRoleClient("cheap");
    const exploreModelClient =
      await this.#createRoleClient("explore");
    const session = new AgentSession({
      id: randomUUID().slice(0, 8),
      title:
        options.title?.trim() ||
        (message ? titleFrom(message) : "新会话"),
      cwd: this.#cwd,
      mode: options.mode ?? runtimeConfig.permissions.mode,
      ...(this.#files ? { files: this.#files } : {}),
      model: await this.#createModel(
        [],
        runtimeConfig.behavior?.crossProjectMemory !== false,
        runtimeConfig.behavior?.maxOutputTokens,
      ),
      stateDir: this.#stateDir,
      permissionRules: [
        ...DEFAULT_PERMISSION_RULES,
        ...runtimeConfig.permissions.rules,
        ...(options.extraPermissionRules ?? []),
      ],
      approvalTimeoutMs:
        runtimeConfig.permissions.approvalTimeoutMs,
      rememberPermission: async (scope, rule) => {
        await this.#configService.addPermissionRule(scope, rule);
      },
      ...(compactModelClient ? { compactModelClient } : {}),
      ...(exploreModelClient ? { exploreModelClient } : {}),
      compactAtEstimatedTokens:
        runtimeConfig.context.compactAtEstimatedTokens,
      keepRecentTokens: runtimeConfig.context.keepRecentTokens,
      parallelTools: runtimeConfig.behavior?.parallelTools === true,
      ...(runtimeConfig.behavior?.subagentTimeoutMs === undefined
        ? {}
        : { subagentTimeoutMs: runtimeConfig.behavior.subagentTimeoutMs }),
      pricing: rolePricing(runtimeConfig.models),
    });
    this.#register(session);
    if (options.title?.trim()) {
      // 显式标题写入事件流（恢复的唯一来源；默认「新会话」/消息推导标题可在恢复时重算）
      session.setTitle(options.title.trim());
    }
    // 外部推送（配置了 notify.* 时）：任务完成/出错/审批超时
    // webhook 推送到外部网关；desktop 弹 macOS 通知中心
    if (runtimeConfig.notify.webhook) {
      new WebhookNotifier(
        (listener) =>
          session.subscribe((record) => listener(record.event)),
        {
          webhookUrl: runtimeConfig.notify.webhook,
          sessionTitle: session.title,
          getSummary: () => session.summary(),
        },
      );
    }
    if (runtimeConfig.notify.desktop === true) {
      new DesktopNotifier(
        (listener) =>
          session.subscribe((record) => listener(record.event)),
        {
          enabled: true,
          sessionTitle: session.title,
        },
      );
    }
    if (message) {
      void session.sendInput(message).catch((error) => {
        // 兜底：sendInput 内部已把 loop/flush 错误转为会话 error 事件，
        // 此处防未来其他 reject 源造成 unhandled rejection 崩进程
        if (error instanceof Error) {
          console.error(
            `[session-manager] sendInput 未处理错误：${error.message}`,
          );
        }
      });
    }
    return session;
  }

  async flush(): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].map(async (session) => {
        await session.flush();
      }),
    );
  }

  async #createModel(
    messages: ConversationMessage[],
    crossProjectMemory = true,
    maxOutputTokens?: number,
  ): Promise<ConversationAgentModel> {
    if (this.#modelFactory) {
      return await this.#modelFactory(messages);
    }
    // 插件注册表在首个模型就绪前填充一次（进程级；会话内工具集保持固定，
    // 新增插件需重启 server 生效）
    await this.#ensurePlugins();
    const client = await this.#createRoleClient("main");
    if (!client) throw new Error("main 角色模型不可用");
    return new ConversationAgentModel(
      client,
      messages,
      new ContextManager({
        cwd: this.#cwd,
        homeDir: this.#homeDir,
        stateDir: this.#stateDir,
        crossProjectMemory,
      }),
      maxOutputTokens === undefined ? {} : { maxTokens: maxOutputTokens },
    );
  }

  async #createRoleClient(
    role: ModelRole,
  ): Promise<ModelClient | undefined> {
    if (this.#modelFactory) return undefined;
    const config = await this.#configService.readEffective();
    return new FallbackModelClient(buildRoleClientChain(role, config));
  }

  /** 进程级插件加载（幂等）：填充全局 PluginToolRegistry；坏文件跳过不阻塞会话 */
  async #ensurePlugins(): Promise<void> {
    if (this.#pluginsLoaded) return;
    this.#pluginsLoaded = true;
    await this.#loadPlugins();
  }

  /**
   * 插件热重载（插件面板「重新加载」）：重建 registry 并重连 MCP server。
   * 生效语义：工具集在每次 prompt 构建时从全局 registry 实时组装，reload 后
   * 后续请求（含运行中会话的下一轮）即用新工具集；prompt cache 前缀自变更点
   * 失效一次（效率损失，非正确性问题）。统计（#stats）跨 reload 保留。
   */
  async reloadPlugins(): Promise<void> {
    await closeMcpClients(this.#mcpClients);
    pluginToolRegistry.clear();
    this.#pluginsLoaded = true;
    await this.#loadPlugins();
  }

  async #loadPlugins(): Promise<void> {
    const runtimeConfig = await this.#configService.readEffective();
    if (runtimeConfig.behavior.enablePlugins === false) {
      this.#pluginReport = { loaded: [], errors: [] };
      return;
    }
    const report = await loadPluginTools(
      this.#homeDir,
      this.#cwd,
      pluginToolRegistry,
    );
    this.#pluginReport = {
      loaded: report.loaded,
      errors: report.errors,
    };
    for (const error of report.errors) {
      console.error(`[plugins] 跳过 ${error.file}：${error.message}`);
    }
    // MCP server：配置驱动（plugins.json 的 mcpServers 段），工具注册进同一注册表；
    // 失败 server 跳过不阻塞；异常退出时同步清理子进程
    const mcpReport = await loadMcpServers(
      this.#homeDir,
      this.#cwd,
      pluginToolRegistry,
      this.#mcpClients,
    );
    this.#pluginReport.errors.push(
      ...mcpReport.errors.map((error) => ({
        file: `mcpServers.${error.name}`,
        message: error.message,
      })),
    );
    for (const error of mcpReport.errors) {
      console.error(`[plugins] MCP server“${error.name}”加载失败：${error.message}`);
    }
    process.once("exit", () => disposeMcpClientsSync(this.#mcpClients));
  }

  /** 关闭全部 MCP 连接（web server 优雅关闭路径调用） */
  async closeMcp(): Promise<void> {
    await closeMcpClients(this.#mcpClients);
  }

  #register(session: AgentSession): void {
    this.#sessions.set(session.id, session);
    this.#maybeGenerateTitle(session);
  }

  /** 首轮对话完成后用 cheap 模型自动生成会话标题 */
  #maybeGenerateTitle(session: AgentSession): void {
    if (session.title !== "新会话" && !session.title.endsWith("…")) return;
    let firstUserText: string | undefined;
    const unsubscribe = session.subscribe((record) => {
      if (record.event.type === "user" && !firstUserText) {
        firstUserText = record.event.text;
      }
      if (
        (record.event.type === "done" || record.event.type === "need_user") &&
        firstUserText
      ) {
        unsubscribe();
        void this.#generateTitle(session, firstUserText).catch(() => undefined);
      }
    });
  }

  async #generateTitle(session: AgentSession, userText: string): Promise<void> {
    await generateSessionTitle({
      createRoleClient: (role) => this.#createRoleClient(role),
      userText,
      onTitle: (title) => session.setTitle(title),
    });
  }

  async #ensureProjectMetadata(): Promise<void> {
    await atomicWriteFile(
      path.join(this.#projectDir, "project.json"),
      JSON.stringify(
        {
          version: 1,
          name: path.basename(this.#cwd),
          cwd: this.#cwd,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
  }
}

async function readRecordedEvents(filePath: string): Promise<RecordedEvent[]> {
  // 容错读取：坏行（崩溃残留半行等）跳过，不毁掉整个会话历史
  const { records } = await readJsonl<RecordedEvent>(filePath);
  return records;
}

function lastPermissionMode(
  records: RecordedEvent[],
): PermissionMode | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const event = records[index]?.event;
    if (event?.type === "permission_mode_changed") return event.mode;
  }
  return undefined;
}

/** 事件流中最近的会话标题（session_info 事件）；无则返回 undefined */
function sessionInfoTitle(
  records: RecordedEvent[],
): string | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const event = records[index]?.event;
    if (event?.type === "session_info") return event.name;
  }
  return undefined;
}
