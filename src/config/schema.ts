import type {
  ModelPricing,
  PermissionMode,
  PermissionRule,
} from "../core/types.js";
import type { ConfigFieldSchema } from "../shared/types.js";

export type { ConfigFieldSchema };

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
  /** 启用推理内容（Anthropic extended thinking / OpenAI reasoning）。
      默认开启（思考质量优先，成本次之）；显式 false 关闭。模型不支持
      extended thinking 时客户端自动降级为不带 thinking 重试。 */
  thinking?: boolean;
  /** thinking 预算（Anthropic budget_tokens，默认 2048） */
  thinkingBudgetTokens?: number;
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
  /** 压缩后保留的最近 token 预算（参照 Pi keepRecentTokens，默认 20k） */
  keepRecentTokens: number;
}

export interface ServerConfig {
  host: string;
  password: string;
  /** /api/v1 无头接口的 Bearer token；空 = 接口未启用 */
  apiToken: string;
}

export interface NotifyConfig {
  webhook: string;
  /** 桌面系统通知（macOS 通知中心）；任务完成/出错/审批超时时弹出 */
  desktop: boolean;
}

export interface BehaviorConfig {
  /** 每轮缓存 miss 提示（tokens/费用）开关；默认关（参照 Pi showCacheMissNotices） */
  showCacheMissNotices: boolean;
  /** 工具并行执行试点（参照 Pi 默认并行）；批次含审批需求时自动退化为串行 */
  parallelTools: boolean;
  /** 注入其他项目记忆标题索引；处理敏感项目的用户可关闭 */
  crossProjectMemory: boolean;
  /** 插件工具通道：加载 ~/.myagent/tools/ 与 .myagent/tools/ 下的自定义工具 */
  enablePlugins: boolean;
  /** 子代理（Task）单次运行超时（ms）；超时强制结束并返回已收集结果。缺省 15 分钟 */
  subagentTimeoutMs?: number;
  /** 单次模型请求最大输出 tokens；缺省 8192（原硬编码 4096 会截断长输出） */
  maxOutputTokens?: number;
  /** 会话保留天数（0 = 不清理）；缺省 30 */
  sessionRetentionDays?: number;
  /** 每日花费上限（元，0 = 不限制）；超出后定时任务暂停触发并顺延 */
  dailyBudgetCny?: number;
}

export interface MyAgentConfig {
  providers: ModelProviderConfig[];
  models: Record<ModelRole, RoleModelConfig>;
  permissions: PermissionConfig;
  context: ContextConfig;
  server: ServerConfig;
  notify: NotifyConfig;
  behavior: BehaviorConfig;
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
  behavior: BehaviorConfig;
  [key: string]: unknown;
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
    key: "server.apiToken",
    type: "string",
    title: "API Token",
    description: "/api/v1 无头接口的 Bearer token（飞书机器人等外部系统集成用）。留空则接口未启用。",
  },
  {
    key: "notify.webhook",
    type: "string",
    title: "通知 Webhook",
    description:
      "任务完成 / 出错 / 审批超时推送到外部（企业微信机器人、飞书机器人、Bark 或任意接受 JSON POST 的网关）。留空则不推送。",
    hot: true,
  },
  {
    key: "notify.desktop",
    type: "boolean",
    title: "桌面通知",
    description:
      "任务完成 / 出错 / 审批超时弹出 macOS 通知中心提示（无需浏览器常驻）。默认关闭。",
    hot: true,
  },
  {
    key: "behavior.showCacheMissNotices",
    type: "boolean",
    title: "缓存 miss 提示",
    description:
      "每轮显示缓存未命中浪费（tokens/费用）。默认关闭避免刷屏；压缩导致的缓存重置说明不受此开关影响。",
    default: false,
    hot: true,
  },
  {
    key: "behavior.parallelTools",
    type: "boolean",
    title: "工具并行执行",
    description:
      "同一轮内多个无需审批的工具并发执行（参照 Pi）。批次含审批需求时自动退化为串行；默认关闭（试点）。",
    default: false,
    hot: true,
  },
  {
    key: "behavior.crossProjectMemory",
    type: "boolean",
    title: "跨项目记忆联想",
    description:
      "向当前会话注入其他项目记忆的标题索引，判断相关时模型可自行调取全文。处理敏感项目时可关闭。",
    default: true,
    hot: true,
  },
  {
    key: "behavior.enablePlugins",
    type: "boolean",
    title: "插件工具",
    description:
      "加载 ~/.myagent/tools/ 与 .myagent/tools/ 下的自定义工具插件（每文件一个工具）。插件与 agent 同权限，只安装信任的插件。",
    default: true,
    hot: true,
  },
  {
    key: "behavior.subagentTimeoutMs",
    type: "number",
    title: "子代理超时（毫秒）",
    description:
      "Task 子代理单次运行超时，超时强制结束并返回已收集结果，防止子代理无界探索拖住主任务。缺省 15 分钟（900000）。",
    default: 900_000,
    hot: true,
  },
  {
    key: "behavior.maxOutputTokens",
    type: "number",
    title: "单次最大输出 tokens",
    description:
      "模型单次请求的输出上限。缺省 8192；长任务输出被截断时可调大（注意输出 token 计费）。",
    default: 8192,
    hot: true,
  },
  {
    key: "behavior.sessionRetentionDays",
    type: "number",
    title: "会话保留天数",
    description:
      "Web 服务启动时与每日清理超过该天数未更新的会话（事件流、书签、分支一并删除）。0 = 不清理。缺省 30。",
    default: 30,
    hot: true,
  },
  {
    key: "behavior.dailyBudgetCny",
    type: "number",
    title: "每日花费上限（元）",
    description:
      "按项目当日累计费用（人民币）超过该值时暂停触发定时任务并顺延。0 = 不限制。缺省 0。",
    default: 0,
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
      thinking: true,
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
    keepRecentTokens: 20_000,
  },
  server: {
    host: "127.0.0.1",
    password: "",
    apiToken: "",
  },
  notify: {
    webhook: "",
    desktop: false,
  },
  behavior: {
    showCacheMissNotices: false,
    parallelTools: false,
    crossProjectMemory: true,
    enablePlugins: true,
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
