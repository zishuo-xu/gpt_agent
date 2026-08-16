import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile } from "../utils/fs.js";
import {
  applyEdits,
  modify,
  parse,
  type ParseError,
} from "jsonc-parser";
import {
  CONFIG_SCHEMA,
  DEFAULT_CONFIG,
  type MyAgentConfig,
  type ContextConfig,
  type ModelProviderConfig,
  type ModelRole,
  type PermissionConfig,
  type PublicMyAgentConfig,
  toPublicConfig,
} from "./schema.js";
import type { PermissionRule } from "../core/types.js";
import { builtinPricingFor } from "./model-pricing.js";

export type ConfigScope = "global" | "project";

export interface ConfigServiceOptions {
  cwd: string;
  homeDir?: string;
}

export interface ProjectKeyOverride {
  id: string;
  name: string;
}

export interface ProjectKeyOverrides {
  cwd: string;
  configPath: string;
  providers: ProjectKeyOverride[];
}

export class ConfigValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super("配置校验失败");
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export class ConfigService {
  readonly #cwd: string;
  readonly #homeDir: string;
  #listeners: Array<(config: MyAgentConfig) => void> = [];

  constructor(options: ConfigServiceOptions) {
    this.#cwd = options.cwd;
    this.#homeDir = options.homeDir ?? os.homedir();
  }

  onChange(listener: (config: MyAgentConfig) => void): () => void {
    this.#listeners.push(listener);
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  }

  get cwd(): string {
    return this.#cwd;
  }

  get homeDir(): string {
    return this.#homeDir;
  }

  pathFor(scope: ConfigScope): string {
    return scope === "global"
      ? path.join(this.#homeDir, ".myagent", "config.jsonc")
      : path.join(this.#cwd, ".myagent", "local.jsonc");
  }

  async read(scope: ConfigScope): Promise<MyAgentConfig> {
    return normalizeConfig(await this.#readRaw(scope));
  }

  async readPublic(scope: ConfigScope): Promise<PublicMyAgentConfig> {
    return toPublicConfig(await this.read(scope));
  }

  /**
   * 读取作用域原始配置；文件不存在返回 undefined。
   */
  async #readRaw(
    scope: ConfigScope,
  ): Promise<Record<string, unknown> | undefined> {
    const filePath = this.pathFor(scope);
    try {
      const text = await readFile(filePath, "utf8");
      const errors: ParseError[] = [];
      const parsed = parse(text, errors, {
        allowTrailingComma: true,
        disallowComments: false,
      }) as Record<string, unknown> | undefined;
      if (errors.length > 0) {
        throw new ConfigValidationError(["配置文件不是有效的 JSONC"]);
      }
      return parsed ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * 生效配置 = 全局层与项目层深合并：项目层显式设置的字段覆盖全局层；
   * providers 按 id 合并（项目层 API Key 为空时继承全局层）；
   * permissions.rules 两层拼接。任一文件缺失则退化为另一层 + Schema 默认。
   */
  async readEffective(): Promise<MyAgentConfig> {
    const [globalRaw, projectRaw] = await Promise.all([
      this.#readRaw("global"),
      this.#readRaw("project"),
    ]);
    return normalizeConfig(mergeLayers(globalRaw, projectRaw));
  }

  /**
   * 检测当前项目的 local.jsonc 中哪些供应商配置了非空 API Key。
   * 合并规则（mergeLayers）：项目层同 id 供应商的非空 Key 覆盖全局层，
   * 这是"设置页保存全局 Key 但会话仍报余额不足"的常见根因。
   * 返回 null 表示项目没有配置文件（无覆盖可能）。
   */
  async findProjectKeyOverrides(): Promise<ProjectKeyOverrides | null> {
    const raw = await this.#readRaw("project");
    if (!raw) return null;
    const providers = Array.isArray(raw.providers) ? raw.providers : [];
    const overrides: ProjectKeyOverride[] = [];
    for (const candidate of providers) {
      if (!candidate || typeof candidate !== "object") continue;
      const provider = candidate as Record<string, unknown>;
      if (
        typeof provider.apiKey === "string" &&
        provider.apiKey.trim() !== ""
      ) {
        overrides.push({
          id: String(provider.id ?? ""),
          name: String(provider.name ?? provider.id ?? ""),
        });
      }
    }
    return {
      cwd: this.#cwd,
      configPath: this.pathFor("project"),
      providers: overrides,
    };
  }

  async addPermissionRule(
    scope: ConfigScope,
    rule: PermissionRule,
  ): Promise<void> {
    const raw = (await this.#readRaw(scope)) ?? {};
    const rawPermissions = (raw.permissions ?? {}) as { rules?: unknown };
    const current = Array.isArray(rawPermissions.rules)
      ? rawPermissions.rules
      : [];
    const rules: PermissionRule[] = current.map((candidate) => {
      const item = candidate as { effect?: unknown; pattern?: unknown };
      return {
        effect: item.effect as PermissionRule["effect"],
        pattern: String(item.pattern),
      };
    });
    if (
      rules.some(
        (candidate) =>
          candidate.effect === rule.effect &&
          candidate.pattern === rule.pattern,
      )
    ) {
      return;
    }
    rules.push(rule);
    // 字段级写入：只修改 permissions.rules，避免把默认/全局配置复制进作用域文件
    await this.writeField(scope, "permissions.rules", rules);
  }

  async writeField(
    scope: ConfigScope,
    keyPath: string,
    value: unknown,
  ): Promise<void> {
    const filePath = this.pathFor(scope);
    const currentText = await readTextOrTemplate(filePath);
    const formatting = { insertSpaces: true, tabSize: 2, eol: "\n" };
    const nextText = applyEdits(
      currentText,
      modify(currentText, keyPath.split("."), value, {
        formattingOptions: formatting,
      }),
    );
    await atomicWriteFile(filePath, nextText);
    await this.#notifyListeners();
  }

  async write(
    scope: ConfigScope,
    incoming: PublicMyAgentConfig | MyAgentConfig,
  ): Promise<PublicMyAgentConfig> {
    const existing = await this.read(scope);
    const merged = mergeSecrets(incoming, existing);
    validateConfig(merged);
    const filePath = this.pathFor(scope);
    const currentText = await readTextOrTemplate(filePath);
    const formatting = { insertSpaces: true, tabSize: 2, eol: "\n" };
    let nextText = currentText;
    for (const field of CONFIG_SCHEMA) {
      // 带点的键（如 server.host）写入嵌套路径，值从嵌套对象取
      const segments = field.key.split(".");
      let value: unknown = merged[field.key];
      if (segments.length === 2) {
        value = (
          merged[segments[0]!] as Record<string, unknown> | undefined
        )?.[segments[1]!];
      }
      nextText = applyEdits(
        nextText,
        modify(nextText, segments, value, {
          formattingOptions: formatting,
        }),
      );
    }
    await atomicWriteFile(filePath, nextText);
    await this.#notifyListeners();
    return toPublicConfig(merged);
  }

  async #notifyListeners(): Promise<void> {
    const config = await this.readEffective();
    for (const listener of this.#listeners) {
      listener(config);
    }
  }
}

function mergeLayers(
  globalRaw: Record<string, unknown> | undefined,
  projectRaw: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const global = globalRaw ?? {};
  const project = projectRaw ?? {};
  const merged: Record<string, unknown> = {};

  // 标量 Schema 字段：项目层显式设置则覆盖全局层（server.host 等嵌套键除外）
  for (const field of CONFIG_SCHEMA) {
    if (!isScalarSchemaField(field.type)) continue;
    if (field.key.includes(".")) continue;
    if (project[field.key] !== undefined) {
      merged[field.key] = project[field.key];
    } else if (global[field.key] !== undefined) {
      merged[field.key] = global[field.key];
    }
  }

  // providers：按 id 合并，项目层覆盖同 id 全局项；API Key 项目层为空时继承全局层
  const providerMap = new Map<string, Record<string, unknown>>();
  for (const candidate of [
    ...(Array.isArray(global.providers) ? global.providers : []),
    ...(Array.isArray(project.providers) ? project.providers : []),
  ]) {
    if (!candidate || typeof candidate !== "object") continue;
    const provider = candidate as Record<string, unknown>;
    const id = String(provider.id ?? "");
    const existing = providerMap.get(id);
    providerMap.set(id, {
      ...(existing ?? {}),
      ...provider,
      apiKey: String(provider.apiKey ?? "") || String(existing?.apiKey ?? ""),
    });
  }
  merged.providers = [...providerMap.values()];

  // models：角色级覆盖（项目层完整指定某角色则整体覆盖）
  const models: Record<string, unknown> = {};
  for (const role of ["main", "cheap", "explore"]) {
    const globalRole = (global.models as Record<string, unknown> | undefined)?.[role];
    const projectRole = (project.models as Record<string, unknown> | undefined)?.[role];
    if (
      projectRole &&
      typeof projectRole === "object" &&
      (projectRole as { providerId?: unknown }).providerId
    ) {
      models[role] = projectRole;
    } else if (globalRole) {
      models[role] = globalRole;
    }
  }
  merged.models = models;

  // permissions：mode / approvalTimeoutMs 字段级覆盖，rules 两层拼接
  const globalPermissions = (global.permissions ?? {}) as Record<string, unknown>;
  const projectPermissions = (project.permissions ?? {}) as Record<string, unknown>;
  merged.permissions = {
    ...globalPermissions,
    ...projectPermissions,
    rules: [
      ...(Array.isArray(globalPermissions.rules) ? globalPermissions.rules : []),
      ...(Array.isArray(projectPermissions.rules) ? projectPermissions.rules : []),
    ],
  };

  merged.context = {
    ...((global.context ?? {}) as Record<string, unknown>),
    ...((project.context ?? {}) as Record<string, unknown>),
  };
  merged.server = {
    ...((global.server ?? {}) as Record<string, unknown>),
    ...((project.server ?? {}) as Record<string, unknown>),
  };
  merged.notify = {
    ...((global.notify ?? {}) as Record<string, unknown>),
    ...((project.notify ?? {}) as Record<string, unknown>),
  };
  merged.behavior = {
    ...((global.behavior ?? {}) as Record<string, unknown>),
    ...((project.behavior ?? {}) as Record<string, unknown>),
  };
  return merged;
}

function normalizeConfig(config?: Partial<MyAgentConfig>): MyAgentConfig {
  config ??= {};
  const providers = Array.isArray(config.providers)
    ? config.providers.map(normalizeProvider)
    : structuredClone(DEFAULT_CONFIG.providers);
  const models = structuredClone(DEFAULT_CONFIG.models);
  for (const role of ["main", "cheap", "explore"] as ModelRole[]) {
    const value = config.models?.[role];
    if (value?.providerId && value.model) {
      models[role] = {
        providerId: String(value.providerId),
        model: String(value.model),
        ...(value.pricing
          ? {
              pricing: {
                inputPerMillionCny: Number(
                  value.pricing.inputPerMillionCny,
                ),
                outputPerMillionCny: Number(
                  value.pricing.outputPerMillionCny,
                ),
                cachedInputPerMillionCny: Number(
                  value.pricing.cachedInputPerMillionCny,
                ),
              },
            }
          : {}),
        ...(Array.isArray(value.fallbacks)
          ? {
              fallbacks: value.fallbacks
                .filter(
                  (fallback) =>
                    fallback?.providerId && fallback.model,
                )
                .map((fallback) => ({
                  providerId: String(fallback.providerId),
                  model: String(fallback.model),
                  ...(fallback.pricing
                    ? {
                        pricing: {
                          inputPerMillionCny: Number(
                            fallback.pricing.inputPerMillionCny,
                          ),
                          outputPerMillionCny: Number(
                            fallback.pricing.outputPerMillionCny,
                          ),
                          cachedInputPerMillionCny: Number(
                            fallback.pricing.cachedInputPerMillionCny,
                          ),
                        },
                      }
                    : {}),
                })),
            }
          : {}),
      };
    }
  }
  // 未显式配置 pricing 的模型，按模型名自动匹配内置默认价格（成本统计开箱即用）
  for (const role of ["main", "cheap", "explore"] as ModelRole[]) {
    const target = models[role];
    if (target && !target.pricing) {
      const builtin = builtinPricingFor(target.model);
      if (builtin) target.pricing = builtin;
    }
    for (const fallback of target?.fallbacks ?? []) {
      if (!fallback.pricing) {
        const builtin = builtinPricingFor(fallback.model);
        if (builtin) fallback.pricing = builtin;
      }
    }
  }
  const permissions: PermissionConfig = {
    mode:
      config.permissions?.mode === "strict" ||
      config.permissions?.mode === "trust"
        ? config.permissions.mode
        : "normal",
    rules: Array.isArray(config.permissions?.rules)
      ? config.permissions.rules
          .filter(
            (rule) =>
              rule &&
              ["allow", "ask", "deny"].includes(rule.effect) &&
              typeof rule.pattern === "string" &&
              rule.pattern.length > 0,
          )
          .map((rule) => ({
            effect: rule.effect,
            pattern: String(rule.pattern),
          }))
      : [],
    approvalTimeoutMs:
      typeof config.permissions?.approvalTimeoutMs === "number"
        ? config.permissions.approvalTimeoutMs
        : 300_000,
  };
  const rawContext = config.context as Record<string, unknown> | undefined;
  const context: ContextConfig = {
    compactAtEstimatedTokens:
      typeof config.context?.compactAtEstimatedTokens === "number"
        ? config.context.compactAtEstimatedTokens
        : 90_000,
    // 旧配置 keepRecentTurns（保留 N 轮）迁移：按每轮约 5k tokens 换算
    keepRecentTokens:
      typeof config.context?.keepRecentTokens === "number"
        ? config.context.keepRecentTokens
        : typeof rawContext?.keepRecentTurns === "number"
          ? (rawContext.keepRecentTurns as number) * 5_000
          : 20_000,
  };
  const rawConfig = config as Record<string, unknown>;
  const normalized: MyAgentConfig = {
    providers,
    models,
    permissions,
    context,
    server: {
      host:
        typeof config.server?.host === "string"
          ? config.server.host
          : typeof rawConfig["server.host"] === "string"
            ? String(rawConfig["server.host"])
            : "127.0.0.1",
      password:
        typeof config.server?.password === "string"
          ? config.server.password
          : typeof rawConfig["server.password"] === "string"
            ? String(rawConfig["server.password"])
            : "",
      apiToken:
        typeof config.server?.apiToken === "string"
          ? config.server.apiToken
          : typeof rawConfig["server.apiToken"] === "string"
            ? String(rawConfig["server.apiToken"])
            : "",
    },
    notify: {
      webhook:
        typeof config.notify?.webhook === "string"
          ? config.notify.webhook
          : "",
      desktop: config.notify?.desktop === true,
    },
    behavior: {
      showCacheMissNotices:
        config.behavior?.showCacheMissNotices === true,
      parallelTools: config.behavior?.parallelTools === true,
      crossProjectMemory: config.behavior?.crossProjectMemory !== false,
      // 带点号的 schema 字段在下方标量循环中被跳过（server.* 同例），此处显式归一化
      enablePlugins: config.behavior?.enablePlugins !== false,
      completionReview: config.behavior?.completionReview === true,
      subagentTimeoutMs:
        typeof config.behavior?.subagentTimeoutMs === "number" &&
        config.behavior.subagentTimeoutMs > 0
          ? config.behavior.subagentTimeoutMs
          : 900_000,
      maxOutputTokens:
        typeof config.behavior?.maxOutputTokens === "number" &&
        config.behavior.maxOutputTokens >= 256
          ? config.behavior.maxOutputTokens
          : 8192,
      sessionRetentionDays:
        typeof config.behavior?.sessionRetentionDays === "number" &&
        Number.isInteger(config.behavior.sessionRetentionDays) &&
        config.behavior.sessionRetentionDays >= 0
          ? config.behavior.sessionRetentionDays
          : 30,
      dailyBudgetCny:
        typeof config.behavior?.dailyBudgetCny === "number" &&
        config.behavior.dailyBudgetCny >= 0
          ? config.behavior.dailyBudgetCny
          : 0,
    },
  };
  for (const field of CONFIG_SCHEMA) {
    if (!isScalarSchemaField(field.type)) continue;
    if (field.key.includes(".")) continue;
    normalized[field.key] = normalizeScalarField(
      field.type,
      config[field.key],
      field.default,
    );
  }
  return normalized;
}

function normalizeProvider(provider: ModelProviderConfig): ModelProviderConfig {
  return {
    id: String(provider.id ?? ""),
    name: String(provider.name ?? ""),
    enabled: provider.enabled !== false,
    protocol:
      provider.protocol === "anthropic" ? "anthropic" : "openai-compatible",
    baseUrl: String(provider.baseUrl ?? ""),
    apiKey: String(provider.apiKey ?? ""),
    models: Array.isArray(provider.models)
      ? provider.models.map(String).filter(Boolean)
      : [],
    // thinking 默认开启（思考质量优先）；显式 false 关闭。模型不支持时
    // 客户端自动降级为不带 thinking 重试，默认开不构成兼容性风险
    thinking: provider.thinking !== false,
    ...(provider.thinkingBudgetTokens === undefined
      ? {}
      : {
          thinkingBudgetTokens: Number(provider.thinkingBudgetTokens) || 2048,
        }),
  };
}

function mergeSecrets(
  incoming: PublicMyAgentConfig | MyAgentConfig,
  existing: MyAgentConfig,
): MyAgentConfig {
  const existingKeys = new Map(
    existing.providers.map((provider) => [provider.id, provider.apiKey]),
  );
  const merged: MyAgentConfig = {
    providers: incoming.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      enabled: provider.enabled,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey || existingKeys.get(provider.id) || "",
      models: [...provider.models],
      ...(provider.thinking === undefined
        ? {}
        : { thinking: provider.thinking }),
      ...(provider.thinkingBudgetTokens === undefined
        ? {}
        : { thinkingBudgetTokens: provider.thinkingBudgetTokens }),
    })),
    models: structuredClone(incoming.models),
    permissions: structuredClone(
      incoming.permissions ?? existing.permissions,
    ),
    context: structuredClone(incoming.context ?? existing.context),
    server: structuredClone(
      incoming.server ?? existing.server,
    ),
    notify: structuredClone(
      incoming.notify ??
        existing.notify ?? { webhook: "", desktop: false },
    ),
    behavior: structuredClone(
      incoming.behavior ??
        existing.behavior ?? {
          showCacheMissNotices: false,
          parallelTools: false,
          crossProjectMemory: true,
        },
    ),
  };
  for (const field of CONFIG_SCHEMA) {
    if (!isScalarSchemaField(field.type)) continue;
    if (field.key.includes(".")) continue;
    merged[field.key] = normalizeScalarField(
      field.type,
      incoming[field.key] ?? existing[field.key],
      field.default,
    );
  }
  return merged;
}

function isScalarSchemaField(
  type: string,
): type is "string" | "number" | "boolean" | "select" {
  return ["string", "number", "boolean", "select"].includes(type);
}

function normalizeScalarField(
  type: "string" | "number" | "boolean" | "select",
  value: unknown,
  fallback: unknown,
): string | number | boolean {
  const candidate = value ?? fallback;
  if (type === "boolean") return candidate === true;
  if (type === "number") {
    const number = Number(candidate);
    return Number.isFinite(number) ? number : Number(fallback ?? 0);
  }
  return typeof candidate === "string"
    ? candidate
    : String(fallback ?? "");
}

function validateConfig(config: MyAgentConfig): void {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const provider of config.providers) {
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(provider.id)) {
      issues.push(`渠道 ID“${provider.id}”格式无效`);
    }
    if (ids.has(provider.id)) issues.push(`渠道 ID“${provider.id}”重复`);
    ids.add(provider.id);
    if (!provider.name.trim()) issues.push(`渠道“${provider.id}”缺少名称`);
    if (
      !provider.enabled &&
      Object.values(config.models).some(
        (selection) =>
          selection.providerId === provider.id ||
          selection.fallbacks?.some(
            (fallback) =>
              fallback.providerId === provider.id,
          ),
      )
    ) {
      issues.push(`渠道“${provider.id}”已禁用，但仍被角色模型使用`);
    }
    if (provider.models.length === 0) {
      issues.push(`渠道“${provider.id}”至少需要一个模型`);
    }
    try {
      const url = new URL(provider.baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      issues.push(`渠道“${provider.id}”的 Base URL 无效`);
    }
  }
  for (const role of ["main", "cheap", "explore"] as ModelRole[]) {
    const selection = config.models[role];
    const targets = [
      selection,
      ...(selection.fallbacks ?? []),
    ];
    for (const [index, target] of targets.entries()) {
      const label =
        index === 0 ? role : `${role} fallback #${index}`;
      const provider = config.providers.find(
        (candidate) => candidate.id === target.providerId,
      );
      if (!provider) {
        issues.push(`${label} 引用了不存在的渠道`);
      } else if (!provider.models.includes(target.model)) {
        issues.push(`${label} 选择的模型不在渠道模型列表中`);
      }
      if (
        target.pricing &&
        Object.values(target.pricing).some(
          (value) => !Number.isFinite(value) || value < 0,
        )
      ) {
        issues.push(
          `${label} 的模型单价必须是大于等于 0 的数字`,
        );
      }
    }
  }
  if (
    !["strict", "normal", "trust"].includes(config.permissions.mode)
  ) {
    issues.push("permissions.mode 必须是 strict、normal 或 trust");
  }
  if (
    !Number.isFinite(config.permissions.approvalTimeoutMs) ||
    config.permissions.approvalTimeoutMs < 1_000
  ) {
    issues.push("permissions.approvalTimeoutMs 不能小于 1000");
  }
  if (
    !Number.isFinite(config.context.compactAtEstimatedTokens) ||
    config.context.compactAtEstimatedTokens < 1_000
  ) {
    issues.push("context.compactAtEstimatedTokens 不能小于 1000");
  }
  if (
    !Number.isInteger(config.context.keepRecentTokens) ||
    config.context.keepRecentTokens < 1_000
  ) {
    issues.push("context.keepRecentTokens 不能小于 1000");
  }
  if (issues.length > 0) throw new ConfigValidationError(issues);
}

async function readTextOrTemplate(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [
      "{",
      "  // MyAgent 本机配置。Web 设置页会保留这行注释。",
      '  "providers": [],',
      '  "models": {},',
      '  "permissions": {},',
      '  "context": {}',
      "}",
      "",
    ].join("\n");
  }
}
