/** 设置页共享类型（App.tsx 与各分区组件共用；对应后端 src/config/schema.ts 的公开结构） */
export type Scope = "global" | "project";
export type Protocol = "anthropic" | "openai-compatible";
export type Role = "main" | "cheap" | "explore";

export interface Provider {
  id: string;
  name: string;
  enabled: boolean;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  hasApiKey: boolean;
  models: string[];
  /** 推理内容（thinking）开关；对应后端 ModelProviderConfig.thinking */
  thinking?: boolean;
  /** 推理预算（tokens）；对应后端 ModelProviderConfig.thinkingBudgetTokens */
  thinkingBudgetTokens?: number;
}

export interface ModelSelection {
  providerId: string;
  model: string;
  pricing?: {
    inputPerMillionCny: number;
    outputPerMillionCny: number;
    cachedInputPerMillionCny: number;
  };
  fallbacks?: ModelSelection[];
}

export interface Config {
  providers: Provider[];
  models: Record<Role, ModelSelection>;
  permissions: {
    mode: "strict" | "normal" | "trust";
    rules: Array<{
      effect: "allow" | "ask" | "deny";
      pattern: string;
    }>;
    approvalTimeoutMs: number;
  };
  context: {
    compactAtEstimatedTokens: number;
    keepRecentTokens: number;
  };
  [key: string]: unknown;
}

export const roleMeta: Record<Role, { label: string; hint: string }> = {
  main: { label: "主循环模型", hint: "复杂推理、编辑与任务执行" },
  cheap: { label: "压缩摘要", hint: "上下文压缩、会话标题" },
  explore: { label: "子代理探索", hint: "代码搜索与只读归纳" },
};

export type ProviderPatch = Partial<Provider>;
