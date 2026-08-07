import { definePluginTool } from "../../src/shared/plugin-tool.js";
import { htmlToText } from "../../src/tools/html-text.js";

/**
 * WebFetch 示例插件：抓取 URL 并返回可见文本。
 * 用法：~/.myagent/tools/（全局）或 .myagent/tools/（项目）下放入本文件，
 * 重启 server 后 main 角色模型即可调用。权限：normal 模式默认需审批
 * （首次批准后可在权限规则中加 "WebFetch(*)" allow 放行）。
 */
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
    },
    required: ["url"],
    additionalProperties: false,
  },
  async run(args, signal) {
    const url = String(args.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) {
      return {
        summary: "WebFetch 参数无效",
        output: "url 必须是 http(s) 绝对地址",
        isError: true,
      };
    }
    const maxChars = clampInteger(args.max_chars, 500, 50_000, 8_000);
    try {
      const response = await fetch(url, {
        signal,
        redirect: "follow",
        headers: { "user-agent": "MyAgent/0.1 (local coding agent)" },
      });
      if (!response.ok) {
        return {
          summary: `HTTP ${response.status}`,
          output: `请求失败：HTTP ${response.status} ${response.statusText}`,
          isError: true,
          details: { url, status: response.status },
        };
      }
      const contentType = response.headers.get("content-type") ?? "";
      const raw = await response.text();
      let text: string;
      if (contentType.includes("html") || /^\s*<!doctype|<html/i.test(raw)) {
        text = htmlToText(raw);
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
        details: { url, status: response.status, chars: text.length, truncated },
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
