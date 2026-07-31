import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

export type ConfigScope = "global" | "project";

export interface ConfigServiceOptions {
  cwd: string;
  homeDir?: string;
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
    const filePath = this.pathFor(scope);
    try {
      const text = await readFile(filePath, "utf8");
      const errors: ParseError[] = [];
      const parsed = parse(text, errors, {
        allowTrailingComma: true,
        disallowComments: false,
      }) as Partial<MyAgentConfig> | undefined;
      if (errors.length > 0) {
        throw new ConfigValidationError(["配置文件不是有效的 JSONC"]);
      }
      return normalizeConfig(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return scope === "project"
          ? await this.read("global")
          : normalizeConfig();
      }
      throw error;
    }
  }

  async readPublic(scope: ConfigScope): Promise<PublicMyAgentConfig> {
    return toPublicConfig(await this.read(scope));
  }

  async readEffective(): Promise<MyAgentConfig> {
    try {
      await access(this.pathFor("project"));
      return await this.read("project");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return await this.read("global");
    }
  }

  async addPermissionRule(
    scope: ConfigScope,
    rule: PermissionRule,
  ): Promise<void> {
    const config = await this.read(scope);
    if (
      config.permissions.rules.some(
        (candidate) =>
          candidate.effect === rule.effect &&
          candidate.pattern === rule.pattern,
      )
    ) {
      return;
    }
    config.permissions.rules.push(rule);
    await this.write(scope, config);
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
      nextText = applyEdits(
        nextText,
        modify(nextText, [field.key], merged[field.key], {
          formattingOptions: formatting,
        }),
      );
    }
    await atomicWrite(filePath, nextText);
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
  const context: ContextConfig = {
    compactAtEstimatedTokens:
      typeof config.context?.compactAtEstimatedTokens === "number"
        ? config.context.compactAtEstimatedTokens
        : 90_000,
    keepRecentTurns:
      typeof config.context?.keepRecentTurns === "number"
        ? config.context.keepRecentTurns
        : 4,
  };
  const normalized: MyAgentConfig = {
    providers,
    models,
    permissions,
    context,
    server: {
      host:
        typeof config.server?.host === "string"
          ? config.server.host
          : "127.0.0.1",
      password:
        typeof config.server?.password === "string"
          ? config.server.password
          : "",
    },
  };
  for (const field of CONFIG_SCHEMA) {
    if (!isScalarSchemaField(field.type)) continue;
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
    })),
    models: structuredClone(incoming.models),
    permissions: structuredClone(
      incoming.permissions ?? existing.permissions,
    ),
    context: structuredClone(incoming.context ?? existing.context),
    server: structuredClone(
      incoming.server ?? existing.server,
    ),
  };
  for (const field of CONFIG_SCHEMA) {
    if (!isScalarSchemaField(field.type)) continue;
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
    !Number.isInteger(config.context.keepRecentTurns) ||
    config.context.keepRecentTurns < 1
  ) {
    issues.push("context.keepRecentTurns 必须是正整数");
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

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
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
