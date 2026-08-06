import type { ConfigScope } from "./config/service.js";
import type { ModelRole, MyAgentConfig } from "./config/schema.js";
import type {
  ApprovalAnswer,
  PermissionRule,
} from "./core/types.js";

/** 按当前值的类型把 CLI 原始字符串强转为配置值（数字/布尔/字符串） */
export function coerceConfigValue(
  current: unknown,
  rawValue: string,
): unknown {
  if (typeof current === "number") {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      throw new Error(`配置项需要数字，收到：${rawValue}`);
    }
    return value;
  }
  if (typeof current === "boolean") {
    const normalized = rawValue.toLowerCase();
    if (!["true", "false"].includes(normalized)) {
      throw new Error(`配置项需要 true/false，收到：${rawValue}`);
    }
    return normalized === "true";
  }
  return rawValue;
}

/** 行输入是否是审批答案（y/n 或 /allow、/deny 前缀） */
export function isApprovalAnswer(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    ["y", "yes", "n", "no"].includes(normalized) ||
    normalized === "/allow" ||
    normalized.startsWith("/allow ") ||
    normalized === "/deny" ||
    normalized.startsWith("/deny ")
  );
}

/** 把审批行解析为统一答案；/allow 可选范围后缀，/deny 可选留言 */
export function parseApprovalAnswer(value: string): ApprovalAnswer {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();
  if (lower === "y" || lower === "yes" || lower === "/allow") {
    return { granted: true, scope: "once" };
  }
  if (lower.startsWith("/allow ")) {
    const requested = lower.slice("/allow ".length).trim();
    const scope: NonNullable<ApprovalAnswer["scope"]> = [
      "once",
      "session",
      "project",
      "global",
    ].includes(requested)
      ? (requested as NonNullable<ApprovalAnswer["scope"]>)
      : "once";
    return { granted: true, scope };
  }
  const feedback = lower.startsWith("/deny ")
    ? normalized.slice("/deny ".length).trim()
    : "";
  return {
    granted: false,
    ...(feedback ? { feedback } : {}),
  };
}

/** /config set <key> <value> [global|project]：拆出键路径、值与作用域 */
export function parseConfigSetLine(
  body: string,
): { keyPath: string; value: string; scope: ConfigScope } {
  const spaceIndex = body.indexOf(" ");
  if (spaceIndex < 0) {
    throw new Error("用法：/config set <key> <value> [global|project]");
  }
  const keyPath = body.slice(0, spaceIndex);
  let value = body.slice(spaceIndex + 1).trim();
  let scope: ConfigScope = "project";
  const lastToken = value.split(/\s+/).at(-1) ?? "";
  if (
    (lastToken === "global" || lastToken === "project") &&
    value.length > lastToken.length
  ) {
    scope = lastToken;
    value = value.slice(0, value.length - lastToken.length).trimEnd();
  }
  return { keyPath, value, scope };
}

/** 生效配置摘要（/config 无参数时的输出） */
export function formatEffectiveConfig(config: MyAgentConfig): string {
  const counts: Record<PermissionRule["effect"], number> = {
    allow: 0,
    ask: 0,
    deny: 0,
  };
  for (const rule of config.permissions.rules) counts[rule.effect]++;
  const modelRoles = (["main", "cheap", "explore"] as ModelRole[])
    .map(
      (role) =>
        `${role}=${config.models[role].providerId}/${config.models[role].model}`,
    )
    .join(" · ");
  return (
    [
      `权限档：${config.permissions.mode} · 审批超时 ${config.permissions.approvalTimeoutMs}ms`,
      `权限规则：allow ${counts.allow} / ask ${counts.ask} / deny ${counts.deny}`,
      `角色模型：${modelRoles}`,
      `上下文：压缩阈值 ${config.context.compactAtEstimatedTokens} tokens · 保留最近 ${config.context.keepRecentTokens} tokens`,
      `Web：host ${config.server.host}${config.server.password ? " · 已设访问密码" : ""}`,
    ].join("\n") + "\n"
  );
}
