import { definePluginTool } from "myagent:protocol";
import { htmlToMainText } from "myagent:html-text";
import { abortableSleep } from "myagent:sleep";

/**
 * WebFetch 示例插件：抓取 URL 并返回可见文本。
 * 用法：~/.myagent/tools/（全局）或 .myagent/tools/（项目）下放入本文件，
 * 重启 server 后 main 角色模型即可调用。权限：normal 模式默认需审批
 * （首次批准后可在权限规则中加 "WebFetch(*)" allow 放行）。
 */

/** 浏览器级请求头：对齐 Chrome 桌面端，规避按 UA/请求特征的反爬 */
export const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "upgrade-insecure-requests": "1",
} as const;

export interface FetchPageResult {
  status: number;
  /** 响应 body 原文（HTML/JSON/文本，由调用方按 content-type 处理） */
  text: string;
}

/**
 * 抓取 URL 返回响应原文（WebFetch 插件与 WebSearch 深度模式共用）。
 * 重试策略：网络错误 / 5xx / 429 重试一次（800ms 退避）；4xx 判定为
 * 确定性拒绝（反爬或页面不存在），重试无意义，不重试。
 */
export async function fetchPageText(
  url: string,
  signal: AbortSignal,
  options?: { cookies?: string },
): Promise<FetchPageResult> {
  const headers: Record<string, string> = { ...BROWSER_HEADERS };
  if (options?.cookies) headers.cookie = options.cookies;
  let lastError = "未知错误";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal,
        redirect: "follow",
        headers,
      });
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return { status: response.status, text: await response.text() };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt === 1) await abortableSleep(800, signal);
  }
  throw new Error(lastError);
}

export default definePluginTool({
  name: "WebFetch",
  description:
    "Fetch a URL and return its visible text content. Use for reading web pages, documentation, and public JSON APIs.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        minLength: 1,
        description: "Absolute http(s) URL",
      },
      max_chars: {
        type: "number",
        description: "Maximum characters of extracted text. Defaults to 8000.",
      },
      cookies: {
        type: "string",
        description:
          "Optional Cookie header value (e.g. \"session=abc; theme=dark\"). " +
          "For pages requiring session cookies.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  async run(args: Record<string, unknown>, signal: AbortSignal) {
    const url = String(args.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) {
      return {
        summary: "WebFetch 参数无效",
        output: "url 必须是 http(s) 绝对地址",
        isError: true,
      };
    }
    const maxChars = clampInteger(args.max_chars, 500, 50_000, 8_000);
    const cookies = String(args.cookies ?? "").trim() || undefined;
    try {
      const { status, text: raw } = await fetchPageText(
        url,
        signal,
        cookies ? { cookies } : {},
      );
      if (status >= 400) {
        return {
          summary: `HTTP ${status}`,
          output: `请求失败：HTTP ${status}`,
          isError: true,
          details: { url, status },
        };
      }
      const contentType = raw.startsWith("{") ? "json" : "html";
      let text: string;
      if (contentType === "html" || /^\s*<!doctype|<html/i.test(raw)) {
        text = htmlToMainText(raw);
      } else if (contentType.includes("json") || raw.trimStart().startsWith("{")) {
        try {
          text = JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          text = raw;
        }
      } else {
        text = raw.trim();
      }
      const truncated = text.length > maxChars;
      const output = truncated
        ? `${text.slice(0, maxChars)}\n[... 已截断，共 ${text.length} 字符，可加大 max_chars 重试 ...]`
        : text;
      return {
        summary: `已抓取 ${url}（${text.length} 字符${truncated ? "，已截断" : ""}）`,
        output,
        details: { url, status, chars: text.length, truncated },
      };
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? "请求被中止"
          : error instanceof Error
            ? error.message
            : "未知错误";
      return {
        summary: `抓取失败：${message}`,
        output: `抓取 ${url} 失败：${message}`,
        isError: true,
        details: { url },
      };
    }
  },
});

function clampInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

