import type { ModelRole } from "../config/schema.js";
import type { ModelClient } from "../model/types.js";

/** 从用户首条消息推导会话标题（36 字截断兜底） */
export function titleFrom(message: string): string {
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

/**
 * 用 cheap 角色模型为会话生成标题（15s 超时；失败时回退首条消息前缀）。
 * 依赖注入：createRoleClient 由调用方提供（会话管理器持有配置与模型工厂）。
 */
export async function generateSessionTitle(options: {
  createRoleClient: (
    role: ModelRole,
  ) => Promise<ModelClient | undefined>;
  userText: string;
  onTitle: (title: string) => void;
}): Promise<void> {
  const { createRoleClient, userText, onTitle } = options;
  const client = await createRoleClient("cheap");
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
      onTitle(fallback);
    }
  } catch {
    // 生成失败时用首条消息的前缀兜底，避免标题永远停在「新会话」
    onTitle(titleFrom(userText));
  } finally {
    clearTimeout(timeout);
  }
}
