import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import type {
  PermissionMode,
  PermissionRule,
  RecordedEvent,
  ToolCall,
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
    });
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
      const session = new AgentSession({
        id,
        title: metadata?.title ?? titleFrom(firstUser.event.text),
        cwd: this.#cwd,
        mode:
          metadata?.permissionMode ??
          lastPermissionMode(records) ??
          runtimeConfig.permissions.mode,
        model: await this.#createModel(conversationFrom(records)),
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
        keepRecentTurns: runtimeConfig.context.keepRecentTurns,
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
      model: await this.#createModel([]),
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
      keepRecentTurns: runtimeConfig.context.keepRecentTurns,
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
        system: "你是一个标题生成器。根据用户的请求，生成一个简短的会话标题（10个字以内）。只返回标题文本，不要任何解释或标点。",
        messages: [{ role: "user", content: userText }],
        signal: controller.signal,
      });
      const title = response.text.trim().replace(/[\n"'`。，,；;：:！!？?]/g, "").slice(0, 20);
      if (title) {
        session.title = title;
        this.#queueIndexWrite();
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async #ensureProjectMetadata(): Promise<void> {
    await atomicWriteJson(
      path.join(this.#projectDir, "project.json"),
      {
        version: 1,
        name: path.basename(this.#cwd),
        cwd: this.#cwd,
        updatedAt: new Date().toISOString(),
      },
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
      await atomicWriteJson(this.#indexPath, file);
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

function conversationFrom(records: RecordedEvent[]): ConversationMessage[] {
  const lastCompaction = [...records]
    .reverse()
    .find((record) => record.event.type === "context_compacted");
  if (
    lastCompaction?.event.type === "context_compacted"
  ) {
    const compactEvent = lastCompaction.event;
    return [
      {
        role: "user",
        content: `[会话压缩摘要]\n${compactEvent.summary}`,
      },
      ...conversationFromRaw(
        records.filter(
          (record) =>
            record.seq >= compactEvent.keepFromSeq &&
            record.event.type !== "context_compacted",
        ),
      ),
    ];
  }
  return conversationFromRaw(records);
}

function conversationFromRaw(
  records: RecordedEvent[],
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const calls = new Map<string, ToolCall>();
  for (const { event } of records) {
    if (event.type === "user") {
      messages.push({
        role: "user",
        content: event.modelText ?? event.text,
      });
    } else if (event.type === "text_delta") {
      messages.push({
        role: "assistant",
        content: event.text,
        toolCalls: [],
      });
    } else if (event.type === "tool_call") {
      calls.set(event.call.id, event.call);
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [event.call],
      });
    } else if (event.type === "tool_result") {
      const call = calls.get(event.callId);
      if (!call) continue;
      messages.push({
        role: "tool",
        toolCallId: event.callId,
        toolName: call.tool,
        target: call.target,
        content:
          event.output === undefined
            ? event.summary
            : `${event.summary}\n${stringify(event.output)}`,
        isError: event.isError ?? Boolean(event.aborted),
      });
    } else if (event.type === "permission_denied") {
      messages.push({
        role: "tool",
        toolCallId: event.call.id,
        toolName: event.call.tool,
        target: event.call.target,
        content: `Permission denied: ${event.reason}`,
        isError: true,
      });
    }
  }
  return messages;
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

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function titleFrom(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 36 ? `${compact.slice(0, 36)}…` : compact;
}

async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
