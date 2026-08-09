import { definePluginTool, type PluginToolRuntimeConfig } from "../../src/shared/plugin-tool.js";
import { htmlToMainText, htmlToText } from "../../src/tools/html-text.js";
import { fetchPageText } from "./web-fetch.js";
import { abortableSleep } from "../../src/utils/sleep.js";

/**
 * WebSearch 示例插件：网络搜索。
 *
 * 声明式配置（config: { section: "webSearch", env: { TAVILY_API_KEY: "tavilyKey" } }），
 * 由插件 loader 统一读取 plugins.json（全局 + 项目两层合并）与环境变量后注入 run 第三参：
 * - SearXNG（自托管元搜索，JSON API）：{ "webSearch": { "provider": "searxng",
 *   "baseUrl": "http://127.0.0.1:8080", "apiToken": "..." } }
 * - Tavily（云服务，需 key）：{ "webSearch": { "provider": "tavily", "apiKey": "tvly-..." } }
 *   或环境变量 TAVILY_API_KEY（等价于 tavily provider）
 * 无配置或 API 失败时自动顺延 HTML 引擎链（bing → duckduckgo → baidu）。
 *
 * 注意：搜索引擎无公开稳定 HTML 接口，降级解析可能随页面结构变化失效；
 * 有 provider 时优先 API，可降低单点风险。
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 深度模式抓取的页面正文（截断后），未抓取时缺省 */
  content?: string;
}

type EngineName = "bing" | "duckduckgo" | "baidu";

const ENGINE_ORDER: EngineName[] = ["bing", "duckduckgo", "baidu"];

interface SearchConfig {
  provider: "tavily" | "searxng";
  apiKey: string;
  baseUrl?: string;
  apiToken?: string;
}

/** 从 loader 注入的运行时配置解析搜索配置（环境变量优先，其次 plugins.json 段） */
export function resolveSearchConfig(
  config?: PluginToolRuntimeConfig,
): SearchConfig | undefined {
  const envKey = config?.env?.tavilyKey?.trim();
  if (envKey) return { provider: "tavily", apiKey: envKey };
  const section = config?.section as Record<string, unknown> | undefined;
  if (!section || typeof section !== "object") return undefined;
  if (section.provider === "searxng") {
    if (typeof section.baseUrl === "string" && section.baseUrl.trim()) {
      return {
        provider: "searxng",
        apiKey: "",
        baseUrl: section.baseUrl.trim(),
        apiToken:
          typeof section.apiToken === "string" ? section.apiToken.trim() : "",
      };
    }
    return undefined;
  }
  if (typeof section.apiKey === "string" && section.apiKey.trim()) {
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

/** 解析 SearXNG JSON 响应（results: [{ title, url, content, score, engines }]） */
export function parseSearxngResponse(payload: unknown): SearchResult[] {
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
        snippet: String(item.content ?? item.snippet ?? "").trim(),
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

async function searchSearxng(
  query: string,
  maxResults: number,
  config: SearchConfig,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const base = (config.baseUrl ?? "").replace(/\/+$/, "");
  const url =
    `${base}/search?q=${encodeURIComponent(query)}` +
    "&format=json&safesearch=1&language=zh-CN";
  const headers: Record<string, string> = {
    // Node fetch 默认不带 UA，SearXNG 上游引擎（google/bing 系）对无 UA
    // 请求返回空结果集（0 条 vs 17 条），必须显式带浏览器 UA
    "user-agent": BROWSER_UA,
  };
  if (config.apiToken) headers.authorization = `Bearer ${config.apiToken}`;
  // SearXNG 聚合的上游引擎瞬时波动（常返回 0 条而非报错）：空结果重试一次
  let lastError = "SearXNG 未返回结果";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      headers,
    });
    if (!response.ok) {
      throw new Error(`SearXNG HTTP ${response.status}`);
    }
    const results = parseSearxngResponse(await response.json()).slice(0, maxResults);
    if (results.length > 0) return results;
    if (attempt === 1) await abortableSleep(800, signal);
  }
  throw new Error(lastError);
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
    .map((result, index) => {
      const contentBlock = result.content
        ? `\n   正文：${result.content}`
        : "";
      return `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}${contentBlock}`;
    })
    .join("\n");
}

/**
 * 深度模式：对前 maxPages 个结果并发抓取正文，失败页面跳过不影响其余。
 * fetcher 由调用方注入（测试传 mock；运行传 fetchPageText + htmlToText），
 * 返回正文或抛错；正文按 maxChars 截断。
 */
export async function attachPageContents(
  results: SearchResult[],
  fetcher: (url: string) => Promise<string>,
  maxPages: number,
  maxChars = 2000,
): Promise<SearchResult[]> {
  const targets = results.slice(0, Math.min(maxPages, results.length));
  const settled = await Promise.allSettled(
    targets.map(async (result) => ({
      url: result.url,
      text: await fetcher(result.url),
    })),
  );
  const contents = new Map<string, string>();
  settled.forEach((entry) => {
    if (entry.status === "fulfilled" && entry.value.text.trim()) {
      contents.set(entry.value.url, entry.value.text.slice(0, maxChars));
    }
  });
  return results.map((result) => {
    const content = contents.get(result.url);
    return content === undefined ? result : { ...result, content };
  });
}

/** 深度模式抓取：8s 单页超时（与会话 signal 组合），非 2xx 抛错跳过 */
async function fetchSearchPage(
  url: string,
  signal: AbortSignal,
): Promise<string> {
  const { status, text } = await fetchPageText(
    url,
    AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
  );
  if (status >= 400) throw new Error(`HTTP ${status}`);
  return htmlToMainText(text).trim();
}

/**
 * 搜索调用节流：串行化 + 最小间隔（默认 1.5s）。
 * 上游搜索引擎对同一 IP 的请求频率高度敏感（实测 3 并发触发整组
 * CAPTCHA/限流），模型连续搜索时用队列摊开请求节奏。
 */
const MIN_SEARCH_INTERVAL_MS = 1_500;
let lastSearchAt = 0;
let searchChain: Promise<void> = Promise.resolve();

export function throttleSearch<T>(task: () => Promise<T>): Promise<T> {
  const run = searchChain.then(async () => {
    const wait = Math.max(
      0,
      MIN_SEARCH_INTERVAL_MS - (Date.now() - lastSearchAt),
    );
    if (wait > 0) {
      await abortableSleep(wait, AbortSignal.timeout(wait + 1_000));
    }
    lastSearchAt = Date.now();
    return await task();
  });
  // 队列不因单个搜索失败而中断后续
  searchChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export default definePluginTool({
  name: "WebSearch",
  description:
    "Search the web and return ranked results with page content. " +
    "By default fetches the top 2 result pages (depth mode) so content is " +
    "ready to use without a separate WebFetch call. Set fetch_pages=0 for snippets only.",
  // 声明式配置：loader 读取 plugins.json 的 webSearch 段 + TAVILY_API_KEY 环境变量，
  // 经 run 第三参注入（resolveSearchConfig 解析）
  config: {
    section: "webSearch",
    env: { TAVILY_API_KEY: "tavilyKey" },
  },
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, description: "Search query" },
      max_results: {
        type: "number",
        description: "Maximum results. Defaults to 5, max 10.",
      },
      fetch_pages: {
        type: "number",
        minimum: 0,
        maximum: 3,
        description:
          "Depth mode: fetch page content for the top N results and include it. " +
          "Defaults to 2. Set 0 to return snippets only.",
      },
      engine: {
        type: "string",
        enum: ["auto", "html", "bing", "duckduckgo", "baidu"],
        description:
          "auto: SearXNG/Tavily API (if configured) with HTML fallback. " +
          "html: force HTML engines (bing, then duckduckgo, then baidu). " +
          "Specific engine names force that engine.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async run(args, signal, runtimeConfig) {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return {
        summary: "WebSearch 参数无效",
        output: "query 不能为空",
        isError: true,
      };
    }
    const maxResults = clampInteger(args.max_results, 1, 10, 5);
    const fetchPages = clampInteger(args.fetch_pages, 0, 3, 2);
    const engineArg = String(args.engine ?? "auto");
    const deepen = async (results: SearchResult[]): Promise<SearchResult[]> =>
      fetchPages > 0 && results.length > 0
        ? await attachPageContents(
            results,
            (url) => fetchSearchPage(url, signal),
            fetchPages,
          )
        : results;

    // API 模式：显式指定 html 引擎或 engine 非 auto 时不走 API
    const config = engineArg === "auto" || engineArg === "html"
      ? resolveSearchConfig(runtimeConfig)
      : undefined;
    if (config) {
      try {
        const results =
          config.provider === "searxng"
            ? await throttleSearch(() =>
                searchSearxng(query, maxResults, config, signal),
              )
            : await throttleSearch(() =>
                searchTavily(query, maxResults, config, signal),
              );
        const enriched = await deepen(results);
        return {
          summary: `搜索“${query}”找到 ${results.length} 条结果（${config.provider}${fetchPages > 0 ? "，已抓取正文" : ""}）`,
          output: formatResults(enriched),
          details: { engine: config.provider, query, results: enriched },
        };
      } catch (error) {
        // API 失败降级 HTML 链，原因附在最终错误信息中
        console.error(
          `[web-search] ${config.provider} 失败，降级 HTML：${
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
      ? `${config.provider} 不可用`
      : engineArg === "auto" || engineArg === "html"
        ? "未配置搜索 API（plugins.json 的 webSearch 段或环境变量 TAVILY_API_KEY）"
        : "";
    for (const engine of order) {
      try {
        const html = await throttleSearch(() =>
          fetchSearch(engine, query, signal),
        );
        const parsed = parseResults(engine, html).slice(0, maxResults);
        if (parsed.length === 0) {
          lastError = `${engine} 未解析到结果（可能被反爬或结构变化）`;
          continue;
        }
        const enriched = await deepen(parsed);
        return {
          summary: `搜索“${query}”找到 ${parsed.length} 条结果（${engine}${fetchPages > 0 ? "，已抓取正文" : ""}）`,
          output: formatResults(enriched),
          details: { engine, query, results: enriched },
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
      output:
        `搜索“${query}”失败：${lastError}\n` +
        "可能原因：上游搜索引擎对当前 IP 限流/风控（常见于密集请求），或网络异常。" +
        "建议：稍后重试、换一个查询词，或改用 WebFetch 直接抓取已知 URL。",
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
