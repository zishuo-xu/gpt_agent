import type {
  ModelPricing,
  PermissionMode,
  PermissionRule,
} from "../core/types.js";

export type ProviderProtocol = "anthropic" | "openai-compatible";
export type ModelRole = "main" | "cheap" | "explore";

export interface ModelProviderConfig {
  id: string;
  name: string;
  enabled: boolean;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export interface RoleModelTarget {
  providerId: string;
  model: string;
  pricing?: ModelPricing;
}

export interface RoleModelConfig extends RoleModelTarget {
  fallbacks?: RoleModelTarget[];
}

export interface PermissionConfig {
  mode: PermissionMode;
  rules: PermissionRule[];
  approvalTimeoutMs: number;
}

export interface ContextConfig {
  compactAtEstimatedTokens: number;
  keepRecentTurns: number;
}

export interface ServerConfig {
  host: string;
  password: string;
}

export interface NotifyConfig {
  webhook: string;
}

export interface MyAgentConfig {
  providers: ModelProviderConfig[];
  models: Record<ModelRole, RoleModelConfig>;
  permissions: PermissionConfig;
  context: ContextConfig;
  server: ServerConfig;
  notify: NotifyConfig;
  [key: string]: unknown;
}

export interface PublicModelProviderConfig
  extends Omit<ModelProviderConfig, "apiKey"> {
  hasApiKey: boolean;
  apiKey: "";
}

export interface PublicMyAgentConfig {
  providers: PublicModelProviderConfig[];
  models: Record<ModelRole, RoleModelConfig>;
  permissions: PermissionConfig;
  context: ContextConfig;
  server: ServerConfig;
  notify: NotifyConfig;
  [key: string]: unknown;
}

export interface ConfigFieldSchema {
  key: string;
  type:
    | "provider[]"
    | "role-models"
    | "permissions"
    | "context"
    | "string"
    | "number"
    | "boolean"
    | "select";
  title: string;
  description: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ label: string; value: string }>;
  hot?: boolean;
  /** 复合字段的渲染器标识，前端按此分派专用组件 */
  renderer?: "provider" | "role-models" | "permissions" | "context";
}

export const CONFIG_SCHEMA: ConfigFieldSchema[] = [
  {
    key: "providers",
    type: "provider[]",
    title: "模型渠道",
    description: "支持 Anthropic 与任意 OpenAI-compatible 第三方端点。",
    hot: true,
    renderer: "provider",
  },
  {
    key: "models",
    type: "role-models",
    title: "角色模型",
    description: "为主循环、压缩摘要和子代理探索分别选择模型。",
    hot: true,
    renderer: "role-models",
  },
  {
    key: "permissions",
    type: "permissions",
    title: "权限与审批",
    description: "会话默认档位、allow/ask/deny 规则与审批超时。",
    hot: true,
    renderer: "permissions",
  },
  {
    key: "context",
    type: "context",
    title: "上下文",
    description: "硬压缩触发阈值与压缩后保留的最近对话轮数。",
    renderer: "context",
  },
  {
    key: "server.host",
    type: "string",
    title: "监听地址",
    description: "Web 服务监听地址。默认 127.0.0.1（仅本机）；设为 0.0.0.0 可从局域网访问（需设密码）。",
    default: "127.0.0.1",
  },
  {
    key: "server.password",
    type: "string",
    title: "访问密码",
    description: "监听非 localhost 时必填。用于远程访问与手机审批场景的密码保护。",
  },
  {
    key: "notify.webhook",
    type: "string",
    title: "通知 Webhook",
    description:
      "任务完成 / 出错 / 审批超时推送到外部（企业微信机器人、飞书机器人、Bark 或任意接受 JSON POST 的网关）。留空则不推送。",
    hot: true,
  },
];

export const DEFAULT_CONFIG: MyAgentConfig = {
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      enabled: true,
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "",
      models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
    },
  ],
  models: {
    main: { providerId: "anthropic", model: "claude-sonnet-4-5" },
    cheap: { providerId: "anthropic", model: "claude-haiku-4-5" },
    explore: { providerId: "anthropic", model: "claude-haiku-4-5" },
  },
  permissions: {
    mode: "normal",
    rules: [],
    approvalTimeoutMs: 300_000,
  },
  context: {
    compactAtEstimatedTokens: 90_000,
    keepRecentTurns: 4,
  },
  server: {
    host: "127.0.0.1",
    password: "",
  },
  notify: {
    webhook: "",
  },
};

export function toPublicConfig(config: MyAgentConfig): PublicMyAgentConfig {
  const { providers, ...rest } = config;
  return {
    ...structuredClone(rest),
    providers: providers.map(({ apiKey, ...provider }) => ({
      ...provider,
      hasApiKey: apiKey.length > 0,
      apiKey: "",
    })),
  };
}
