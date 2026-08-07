import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { definePluginTool } from "../../src/shared/plugin-tool.js";
import { htmlToText } from "../../src/tools/html-text.js";

/**
 * WebSearch 示例插件：网络搜索。
 *
 * 两级策略（混合）：
 * 1) API 模式（推荐）：配置 Tavily API key 后走结构化搜索，返回 title/url/content
 *    （页面正文），agent 一次调用即拿到素材，无需再 WebFetch。key 配置：
 *    - 环境变量 TAVILY_API_KEY；或
 *    - ~/.myagent/plugins.json / <cwd>/.myagent/plugins.json（项目覆盖全局）：
 *      { "webSearch": { "provider": "tavily", "apiKey": "tvly-..." } }
 * 2) 降级模式：无 key 或 API 失败时自动顺延 HTML 引擎链
 *    （bing → duckduckgo → baidu），免配置但依赖页面结构。
 *
 * 注意：搜索引擎无公开稳定 HTML 接口，降级解析可能随页面结构变化失效；
 * 有 key 时优先 API，可降低单点风险。
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

type EngineName = "bing" | "duckduckgo" | "baidu";

const ENGINE_ORDER: EngineName[] = ["bing", "duckduckgo", "baidu"];

interface SearchConfig {
  provider: "tavily";
  apiKey: string;
}

/** 读取搜索配置：环境变量优先，其次 plugins.json（项目层覆盖全局层） */
export async function loadSearchConfig(
  homeDir = os.homedir(),
  cwd = process.cwd(),
): Promise<SearchConfig | undefined> {
  const envKey = process.env.TAVILY_API_KEY?.trim();
  if (envKey) return { provider: "tavily", apiKey: envKey };
  const layers = [
    path.join(homeDir, ".myagent", "plugins.json"),
    path.join(cwd, ".myagent", "plugins.json"),
  ];
  let merged: Record<string, unknown> = {};
  for (const file of layers) {
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      // 浅合并（对象层覆盖），项目层在后
      merged = { ...merged, ...raw };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[plugins] 读取 ${file} 失败：${(error as Error).message}`);
      }
    }
  }
  const section = merged.webSearch as
    | Record<string, unknown>
    | undefined;
  if (section && typeof section.apiKey === "string" && section.apiKey.trim()) {
    return { provider: "tavily", apiKey: section.apiKey.trim() };
  }
  return undefined;
}

/** 解析 Tavily 响应（results: [{ title, url, content, score, published_date? }]） */
export function parseTavilyResponse(payload: unknown): SearchResult[] {
  const results = Array.isArray(
    (payload as { results?: unknown })?.results,
  )
    ? (payload as { results: unknown[] }).results
    : [];
  return results
    .map((raw) => {
      const item = raw as Record<string, unknown>;
      return {
        title: String(item.title ?? "").trim(),
        url: String(item.url ?? "").trim(),
        snippet: String(item.content ?? "").trim(),
      };
    })
    .filter((result) => result.title && result.url);
}

async function searchTavily(
  query: string,
  maxResults: number,
  config: SearchConfig,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: config.apiKey,
      query,
      max_results: maxResults,
      search_depth: "basic",
    }),
  });
  if (!response.ok) {
    throw new Error(`Tavily HTTP ${response.status}`);
  }
  const results = parseTavilyResponse(await response.json());
  if (results.length === 0) throw new Error("Tavily 未返回结果");
  return results;
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function fetchSearch(
  engine: EngineName,
  query: string,
  signal: AbortSignal,
): Promise<string> {
  const url =
    engine === "bing"
      ? `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10`
      : engine === "duckduckgo"
        ? `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`
        : `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=10`;
  // 每引擎 15s 超时（与会话 signal 组合）
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    redirect: "follow",
    headers: {
      "user-agent": BROWSER_UA,
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`${engine} HTTP ${response.status}`);
  }
  return await response.text();
}

/** 提取搜索结果块内的标题/URL（解码标签与实体） */
function cleanTitle(raw: string): string {
  return htmlToText(raw);
}

function decodeDdgUrl(href: string): string {
  // DDG lite 结果链接为 https://duckduckgo.com/l/?uddg=<encodeURIComponent(url)>
  const match = href.match(/[?&]uddg=([^&]+)/);
  if (match) {
    try {
      return decodeURIComponent(match[1]!);
    } catch {
      // 解码失败原样返回
    }
  }
  return href;
}

function decodeBingUrl(href: string): string {
  // Bing 重定向 /ck/a?...&u=a1aHR0cHM6...（u 参数为 base64 编码的真实 URL）
  if (!href.includes("/ck/a?")) return href;
  const match = href.match(/[?&]u=([^&]+)/);
  if (!match) return href;
  try {
    const padded = match[1]!.padEnd(
      Math.ceil(match[1]!.length / 4) * 4,
      "=",
    );
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : href;
  } catch {
    return href;
  }
}

/** 解析 Bing 搜索结果页（<li class="b_algo"> 块） */
export function parseBingResults(html: string): SearchResult[] {
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) ?? [];
  const results: SearchResult[] = [];
  for (const block of blocks) {
    // 真实 HTML 中 <a> 与 href 之间可能有 target 等属性，不可假设直接相邻
    const link = block.match(
      /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!link) continue;
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch
      ? htmlToText(snippetMatch[1]!)
      : "";
    results.push({
      title: cleanTitle(link[2]!),
      url: decodeBingUrl(link[1]!),
      snippet,
    });
  }
  return results;
}

/** 解析 DuckDuckGo lite 结果页（链接 + result-snippet 交替行） */
export function parseDuckDuckGoResults(html: string): SearchResult[] {
  const links =
    html.match(/<a rel="nofollow" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi) ?? [];
  const snippets =
    html.match(/<td class='result-snippet'[^>]*>([\s\S]*?)<\/td>/gi) ?? [];
  const results: SearchResult[] = [];
  for (let index = 0; index < links.length; index += 1) {
    const linkMatch = links[index]!.match(
      /<a rel="nofollow" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!linkMatch) continue;
    const snippet = snippets[index]
      ? htmlToText(snippets[index]!.replace(/^<td[^>]*>|<\/td>$/g, ""))
      : "";
    results.push({
      title: cleanTitle(linkMatch[2]!),
      url: decodeDdgUrl(linkMatch[1]!),
      snippet,
    });
  }
  return results;
}

/** 解析百度结果页（h3.c-title 块 + c-abstract 摘要） */
export function parseBaiduResults(html: string): SearchResult[] {
  const blocks =
    html.match(/<h3[^>]*class="[^"]*c-title[^"]*"[\s\S]*?<\/h3>/gi) ?? [];
  const results: SearchResult[] = [];
  for (const block of blocks) {
    const link = block.match(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    results.push({
      title: cleanTitle(link[2]!),
      url: link[1]!,
      snippet: "",
    });
  }
  // 摘要单独抽取（c-abstract 块与标题块不嵌套）
  const abstracts =
    html.match(/<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/gi) ?? [];
  for (let index = 0; index < abstracts.length && index < results.length; index += 1) {
    results[index]!.snippet = htmlToText(
      abstracts[index]!.replace(/^<div[^>]*>|<\/div>$/g, ""),
    );
  }
  return results;
}

function parseResults(engine: EngineName, html: string): SearchResult[] {
  if (engine === "bing") return parseBingResults(html);
  if (engine === "duckduckgo") return parseDuckDuckGoResults(html);
  return parseBaiduResults(html);
}

function formatResults(results: SearchResult[]): string {
  return results
    .map(
      (result, index) =>
        `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`,
    )
    .join("\n");
}

export default definePluginTool({
  name: "WebSearch",
  description:
    "Search the web and return ranked results (title, URL, snippet). " +
    "Use to discover relevant pages, then fetch details with WebFetch.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, description: "Search query" },
      max_results: {
        type: "number",
        description: "Maximum results. Defaults to 5, max 10.",
      },
      engine: {
        type: "string",
        enum: ["auto", "html", "bing", "duckduckgo", "baidu"],
        description:
          "auto: Tavily API (if configured) with HTML fallback. " +
          "html: force HTML engines (bing, then duckduckgo, then baidu). " +
          "Specific engine names force that engine.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async run(args, signal) {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return {
        summary: "WebSearch 参数无效",
        output: "query 不能为空",
        isError: true,
      };
    }
    const maxResults = clampInteger(args.max_results, 1, 10, 5);
    const engineArg = String(args.engine ?? "auto");

    // API 模式：显式指定 html 引擎或 engine 非 auto 时不走 API
    const config = engineArg === "auto" || engineArg === "html"
      ? await loadSearchConfig()
      : undefined;
    if (config) {
      try {
        const results = await searchTavily(query, maxResults, config, signal);
        return {
          summary: `搜索“${query}”找到 ${results.length} 条结果（tavily）`,
          output: formatResults(results),
          details: { engine: "tavily", query, results },
        };
      } catch (error) {
        // API 失败降级 HTML 链，原因附在最终错误信息中
        console.error(
          `[web-search] Tavily 失败，降级 HTML：${
            error instanceof Error ? error.message : "未知错误"
          }`,
        );
      }
    }

    const order: EngineName[] =
      engineArg === "auto" || engineArg === "html"
        ? ENGINE_ORDER
        : ([engineArg] as EngineName[]);

    let lastError = config
      ? "Tavily 不可用"
      : engineArg === "auto" || engineArg === "html"
        ? "未配置 API key（可在 ~/.myagent/plugins.json 或环境变量 TAVILY_API_KEY 配置）"
        : "";
    for (const engine of order) {
      try {
        const html = await fetchSearch(engine, query, signal);
        const parsed = parseResults(engine, html).slice(0, maxResults);
        if (parsed.length === 0) {
          lastError = `${engine} 未解析到结果（可能被反爬或结构变化）`;
          continue;
        }
        return {
          summary: `搜索“${query}”找到 ${parsed.length} 条结果（${engine}）`,
          output: formatResults(parsed),
          details: { engine, query, results: parsed },
        };
      } catch (error) {
        lastError =
          error instanceof Error && error.name === "AbortError"
            ? `${engine} 请求被中止`
            : error instanceof Error
              ? `${engine}：${error.message}`
              : `${engine}：未知错误`;
      }
    }
    return {
      summary: "搜索失败",
      output: `搜索“${query}”失败：${lastError}`,
      isError: true,
      details: { query },
    };
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
