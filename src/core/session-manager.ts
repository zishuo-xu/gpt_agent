import { randomUUID } from "node:crypto";
import {
  readdir,
  readFile,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile } from "../utils/fs.js";
import type { ConfigService } from "../config/service.js";
import type {
  ModelProviderConfig,
  ModelRole,
} from "../config/schema.js";
import { WebhookNotifier } from "./notifier.js";
import { ConversationAgentModel } from "../model/agent-model.js";
import { ConfiguredModelClient } from "../model/client.js";
import {
  FallbackModelClient,
  ResilientModelClient,
} from "../model/resilient-client.js";
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

interface SessionIndexEntry {
  id: string;
  title: string;
  permissionMode: PermissionMode;
  createdAt: string;
  updatedAt: string;
  status: AgentSessionSummary["status"];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCostCny?: number;
  toolCallCount?: number;
  kind?: "interactive" | "run";
}

interface SessionIndexFile {
  version: 1;
  sessions: SessionIndexEntry[];
}

export interface AgentSessionManagerOptions {
  cwd: string;
  configService: ConfigService;
  stateDir?: string;
  homeDir?: string;
  modelFactory?: (
    messages: ConversationMessage[],
  ) => Promise<ConversationAgentModel> | ConversationAgentModel;
}

export class AgentSessionManager {
  readonly #cwd: string;
  readonly #configService: ConfigService;
  readonly #stateDir: string;
  readonly #homeDir: string;
  readonly #sessionsDir: string;
  readonly #projectDir: string;
  readonly #indexPath: string;
  readonly #modelFactory:
    | AgentSessionManagerOptions["modelFactory"]
    | undefined;
  readonly #sessions = new Map<string, AgentSession>();
  #indexWriteTail: Promise<void> = Promise.resolve();

  constructor(options: AgentSessionManagerOptions) {
    this.#cwd = options.cwd;
    this.#configService = options.configService;
    this.#stateDir =
      options.stateDir ?? path.join(os.homedir(), ".myagent");
    this.#homeDir = options.homeDir ?? os.homedir();
    this.#modelFactory = options.modelFactory;
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
    this.#indexPath = path.join(this.#sessionsDir, "index.json");
    this.#configService.onChange((config) => {
      for (const session of this.#sessions.values()) {
        session.applyConfigChange(config);
      }
      // 重建模型客户端：API Key / 模型 / fallback 等配置变更即时生效
      void this.#refreshModelClients().catch(() => undefined);
    });
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

  get(id: string): AgentSession | undefined {
    return this.#sessions.get(id);
  }

  async deleteSession(id: string): Promise<boolean> {
    const session = this.#sessions.get(id);
    if (!session) return false;
    if (session.isProcessing()) {
      // 运行中的会话先硬中止，避免删除后仍向磁盘追加写入
      session.interrupt();
    }
    this.#sessions.delete(id);
    this.#queueIndexWrite();
    await this.flush();
    for (const suffix of [".jsonl", ".trace.jsonl"]) {
      await unlink(path.join(this.#sessionsDir, `${id}${suffix}`)).catch(
        () => undefined,
      );
    }
    return true;
  }

  async restore(): Promise<void> {
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
    const index = await this.#readIndex();
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
      const metadata = index.get(id);
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
          metadata?.title ??
          titleFrom(firstUser.event.text),
        cwd: this.#cwd,
        mode:
          metadata?.permissionMode ??
          lastPermissionMode(records) ??
          runtimeConfig.permissions.mode,
        // 恢复当前分支链视角的消息历史（分支点之前不变，之后只含当前分支）
        model: await this.#createModel(
          conversationFrom(records, branches, branchId),
          runtimeConfig.behavior?.crossProjectMemory !== false,
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
        pricing: rolePricing(runtimeConfig.models),
      });
      this.#register(session);
    }
    this.#queueIndexWrite();
    await this.flush();
  }

  async createSession(options: {
    title?: string;
    mode?: PermissionMode;
    initialMessage?: string;
    /** 追加到默认+配置规则之上的权限规则（如大厅模式禁用文件写入） */
    extraPermissionRules?: PermissionRule[];
  } = {}): Promise<AgentSession> {
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
      model: await this.#createModel(
        [],
        runtimeConfig.behavior?.crossProjectMemory !== false,
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
      pricing: rolePricing(runtimeConfig.models),
    });
    this.#register(session);
    this.#queueIndexWrite();
    // 外部 webhook 推送（配置了 notify.webhook 时）：任务完成/出错/审批超时
    if (runtimeConfig.notify.webhook) {
      new WebhookNotifier(
        (listener) =>
          session.subscribe((record) => listener(record.event)),
        {
          webhookUrl: runtimeConfig.notify.webhook,
          sessionTitle: session.title,
        },
      );
    }
    if (message) void session.sendInput(message);
    return session;
  }

  async flush(): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].map(async (session) => {
        await session.flush();
      }),
    );
    await this.#indexWriteTail;
  }

  async #createModel(
    messages: ConversationMessage[],
    crossProjectMemory = true,
  ): Promise<ConversationAgentModel> {
    if (this.#modelFactory) {
      return await this.#modelFactory(messages);
    }
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
    );
  }

  async #createRoleClient(
    role: ModelRole,
  ): Promise<ModelClient | undefined> {
    if (this.#modelFactory) return undefined;
    const config = await this.#configService.readEffective();
    const selection = config.models[role];
    const targets = [
      selection,
      ...(selection.fallbacks ?? []),
    ];
    return new FallbackModelClient(
      targets.map((target) => {
        const provider = config.providers.find(
          (candidate) => candidate.id === target.providerId,
        );
        const inner = provider
          ? createConfiguredClient(provider, target.model)
          : failingModelClient(
              `${role} 角色引用了不存在的供应商：${target.providerId}`,
            );
        return {
          id: `${target.providerId}/${target.model}`,
          client: new ResilientModelClient(inner),
          ...(target.pricing
            ? { pricing: target.pricing }
            : {}),
        };
      }),
    );
  }

  #register(session: AgentSession): void {
    this.#sessions.set(session.id, session);
    session.subscribe(() => this.#queueIndexWrite());
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
    const client = await this.#createRoleClient("cheap");
    if (!client) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    timeout.unref();
    try {
      const response = await client.complete({
        system:
          "你是一个标题生成器。根据用户的请求，生成一个简短的中文会话标题（10个字以内）。只返回标题文本，不要任何解释、标点或引号。",
        messages: [{ role: "user", content: userText }],
        // 标题生成不需要工具调用，不携带工具 schema（省 token）
        tools: [],
        signal: controller.signal,
      });
      const title = clipTitle(response.text);
      // 用户请求是中文但模型返回了纯英文标题时，回退到请求原文前缀
      const fallback =
        title && hasChinese(userText) && !hasChinese(title)
          ? titleFrom(userText)
          : title;
      if (fallback) {
        session.setTitle(fallback);
        this.#queueIndexWrite();
      }
    } catch {
      // 生成失败时用首条消息的前缀兜底，避免标题永远停在「新会话」
      session.setTitle(titleFrom(userText));
      this.#queueIndexWrite();
    } finally {
      clearTimeout(timeout);
    }
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

  #queueIndexWrite(): void {
    this.#indexWriteTail = this.#indexWriteTail.then(async () => {
      const file: SessionIndexFile = {
        version: 1,
        sessions: this.list().map((summary) => ({
          id: summary.id,
          title: summary.title,
          permissionMode: summary.permissionMode,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          status: summary.status,
          totalInputTokens: summary.totalInputTokens,
          totalOutputTokens: summary.totalOutputTokens,
          totalCachedTokens: summary.totalCachedTokens,
          totalCostCny: summary.totalCostCny,
          toolCallCount: summary.toolCallCount,
          kind: summary.kind,
        })),
      };
      await atomicWriteFile(
        this.#indexPath,
        JSON.stringify(file, null, 2) + "\n",
      );
    });
  }

  async #readIndex(): Promise<Map<string, SessionIndexEntry>> {
    try {
      const parsed = JSON.parse(
        await readFile(this.#indexPath, "utf8"),
      ) as Partial<SessionIndexFile>;
      return new Map(
        (parsed.sessions ?? []).map((entry) => [entry.id, entry]),
      );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        error instanceof SyntaxError
      ) {
        return new Map();
      }
      throw error;
    }
  }
}

function rolePricing(
  models: Awaited<
    ReturnType<ConfigService["readEffective"]>
  >["models"],
) {
  return {
    ...(models.main.pricing
      ? { main: models.main.pricing }
      : {}),
    ...(models.cheap.pricing
      ? { cheap: models.cheap.pricing }
      : {}),
    ...(models.explore.pricing
      ? { explore: models.explore.pricing }
      : {}),
  };
}

function createConfiguredClient(
  provider: ModelProviderConfig,
  model: string,
): ModelClient {
  try {
    return new ConfiguredModelClient(provider, model);
  } catch (error) {
    return {
      async complete() {
        throw error;
      },
    };
  }
}

function failingModelClient(message: string): ModelClient {
  return {
    async complete() {
      throw new Error(message);
    },
  };
}

async function readRecordedEvents(filePath: string): Promise<RecordedEvent[]> {
  const content = await readFile(filePath, "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedEvent);
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

function titleFrom(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 36 ? `${compact.slice(0, 36)}…` : compact;
}

/** 是否包含 CJK 字符（用于标题语言守卫） */
function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

/** 清洗标点并按长度智能截断：优先在单词/分词边界切断，避免英文残词 */
function clipTitle(text: string, max = 20): string {
  const cleaned = text
    .replace(/[\n"'`。，,；;：:！!？?]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max);
  const boundary = Math.max(
    cut.lastIndexOf(" "),
    cut.lastIndexOf("-"),
    cut.lastIndexOf("/"),
  );
  if (boundary > max * 0.4) return `${cut.slice(0, boundary).trimEnd()}…`;
  return `${cut.trimEnd()}…`;
}
