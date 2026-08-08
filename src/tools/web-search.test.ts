import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  attachPageContents,
  loadSearchConfig,
  parseBaiduResults,
  parseBingResults,
  parseDuckDuckGoResults,
  parseSearxngResponse,
  parseTavilyResponse,
} from "../../.myagent/tools/web-search.js";

test("Bing 解析：b_algo 块提取标题/链接/摘要并解码重定向", () => {
  const html = `
  <li class="b_algo"><h2 class=""><a target="_blank" href="https://example.com/docs?a=1">Example <strong>Docs</strong></a></h2>
    <div class="b_caption"><p>Example 官方文档，包含 <strong>API</strong> 参考。</p></div></li>
  <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=aHR0cHM6Ly9naXRodWIuY29tL3JlcG8&ntb=1">GitHub Repo</a></h2>
    <div class="b_caption"><p>源码仓库页面。</p></div></li>`;
  const results = parseBingResults(html);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.title, "Example Docs");
  assert.equal(results[0]!.url, "https://example.com/docs?a=1");
  assert.match(results[0]!.snippet, /官方文档/);
  // 重定向 URL 应解码为真实地址
  assert.equal(results[1]!.url, "https://github.com/repo");
});

test("Bing 解析：空页面返回空数组", () => {
  assert.deepEqual(parseBingResults("<html><body>no results</body></html>"), []);
});

test("DuckDuckGo lite 解析：链接与摘要配对，uddg 解码", () => {
  const html = `
  <a rel="nofollow" href="https://duckduckgo.com/l/?uddg=${encodeURIComponent("https://example.com/page?x=1&y=2")}&rut=abc">Example Page</a>
  <td class='result-snippet'>第一段摘要。</td>
  <a rel="nofollow" href="https://example.org/plain">Plain Link</a>
  <td class='result-snippet'>第二段摘要。</td>`;
  const results = parseDuckDuckGoResults(html);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.title, "Example Page");
  assert.equal(results[0]!.url, "https://example.com/page?x=1&y=2");
  assert.equal(results[0]!.snippet, "第一段摘要。");
  assert.equal(results[1]!.url, "https://example.org/plain");
  assert.equal(results[1]!.snippet, "第二段摘要。");
});

test("DuckDuckGo 解析：无结果返回空数组", () => {
  assert.deepEqual(parseDuckDuckGoResults("<html><table></table></html>"), []);
});

test("Baidu 解析：c-title 标题 + c-abstract 摘要配对", () => {
  const html = `
  <h3 class="c-title c-title-new" t="1"><a href="https://baike.baidu.com/item/x">百度百科条目</a></h3>
  <div class="c-abstract">这是百科摘要内容。</div>
  <h3 class="c-title"><a href="https://example.com/a">普通站点</a></h3>`;
  const results = parseBaiduResults(html);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.title, "百度百科条目");
  assert.equal(results[0]!.url, "https://baike.baidu.com/item/x");
  assert.equal(results[0]!.snippet, "这是百科摘要内容。");
  assert.equal(results[1]!.snippet, "", "无对应摘要时为空");
});

test("Tavily 响应解析为 SearchResult（含 content 正文）", () => {
  const results = parseTavilyResponse({
    query: "test",
    results: [
      {
        title: "TypeScript 官网",
        url: "https://www.typescriptlang.org/",
        content: "TypeScript is JavaScript with syntax for types.",
        score: 0.98,
      },
      { title: "无 URL 条目", content: "x" },
      { url: "https://example.com/no-title", content: "y" },
    ],
  });
  assert.equal(results.length, 1, "缺 title 或 url 的条目被过滤");
  assert.equal(results[0]!.title, "TypeScript 官网");
  assert.equal(results[0]!.url, "https://www.typescriptlang.org/");
  assert.match(results[0]!.snippet, /syntax for types/);
});

test("Tavily 空响应与非数组 results 返回空数组", () => {
  assert.deepEqual(parseTavilyResponse({}), []);
  assert.deepEqual(parseTavilyResponse({ results: "oops" }), []);
});

test("loadSearchConfig：环境变量优先，plugins.json 项目层覆盖全局层", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-searchcfg-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(home, ".myagent"), { recursive: true });
  await mkdir(path.join(project, ".myagent"), { recursive: true });

  try {
    // 无任何配置 → undefined
    assert.equal(await loadSearchConfig(home, project), undefined);

    // 环境变量优先
    process.env.TAVILY_API_KEY = "tvly-env-key";
    assert.equal((await loadSearchConfig(home, project))?.apiKey, "tvly-env-key");
    delete process.env.TAVILY_API_KEY;

    // 全局层配置
    await writeFile(
      path.join(home, ".myagent", "plugins.json"),
      JSON.stringify({ webSearch: { provider: "tavily", apiKey: "tvly-global" } }),
      "utf8",
    );
    assert.equal((await loadSearchConfig(home, project))?.apiKey, "tvly-global");

    // 项目层覆盖全局层
    await writeFile(
      path.join(project, ".myagent", "plugins.json"),
      JSON.stringify({ webSearch: { apiKey: "tvly-project" } }),
      "utf8",
    );
    assert.equal((await loadSearchConfig(home, project))?.apiKey, "tvly-project");
  } finally {
    delete process.env.TAVILY_API_KEY;
    await rm(root, { recursive: true, force: true });
  }
});

test("SearXNG 响应解析：content 字段映射为 snippet，过滤缺 title/url 条目", () => {
  const results = parseSearxngResponse({
    query: "test",
    results: [
      {
        template: "default.html",
        title: "TypeScript 官方文档",
        content: "TypeScript is JavaScript with syntax for types.",
        url: "https://www.typescriptlang.org/",
        score: 1.0,
        engines: ["google", "bing"],
      },
      { title: "缺 URL", content: "x" },
      { url: "https://example.com/no-title", content: "y" },
      { title: "snippet 回退", snippet: "旧字段", url: "https://example.com/s" },
    ],
  });
  assert.equal(results.length, 2, "缺 title 或 url 的条目被过滤");
  assert.equal(results[0]!.title, "TypeScript 官方文档");
  assert.equal(results[0]!.url, "https://www.typescriptlang.org/");
  assert.match(results[0]!.snippet, /syntax for types/);
  assert.equal(results[1]!.snippet, "旧字段", "无 content 时回退 snippet 字段");
});

test("loadSearchConfig：searxng provider 读取 baseUrl 与 apiToken", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-searchcfg-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(home, ".myagent"), { recursive: true });
  await mkdir(path.join(project, ".myagent"), { recursive: true });
  try {
    // 全局 tavily + 项目 searxng：项目层覆盖
    await writeFile(
      path.join(home, ".myagent", "plugins.json"),
      JSON.stringify({ webSearch: { provider: "tavily", apiKey: "tvly-global" } }),
      "utf8",
    );
    await writeFile(
      path.join(project, ".myagent", "plugins.json"),
      JSON.stringify({
        webSearch: {
          provider: "searxng",
          baseUrl: "http://127.0.0.1:8080/",
          apiToken: "local-token",
        },
      }),
      "utf8",
    );
    const config = await loadSearchConfig(home, project);
    assert.equal(config?.provider, "searxng");
    assert.equal(config?.baseUrl, "http://127.0.0.1:8080/");
    assert.equal(config?.apiToken, "local-token");

    // searxng 缺 baseUrl → 无配置（不误判为 tavily）
    await writeFile(
      path.join(project, ".myagent", "plugins.json"),
      JSON.stringify({ webSearch: { provider: "searxng", apiToken: "x" } }),
      "utf8",
    );
    assert.equal(await loadSearchConfig(home, project), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("深度模式 attachPageContents：成功抓取、失败跳过、正文截断、数量限制", async () => {
  const results = [
    { title: "A", url: "https://a.example/", snippet: "s1" },
    { title: "B", url: "https://b.example/", snippet: "s2" },
    { title: "C", url: "https://c.example/", snippet: "s3" },
    { title: "D", url: "https://d.example/", snippet: "s4" },
  ];
  const fetcher = async (url: string): Promise<string> => {
    if (url === "https://b.example/") throw new Error("HTTP 403");
    return `${url} 的正文内容，比较长的一段文字用于验证截断行为。`.repeat(50);
  };
  // 只抓前 2 个：A 成功、B 失败 → C/D 不抓取，B 无正文但保留
  const enriched = await attachPageContents(results, fetcher, 2, 80);
  assert.equal(enriched.length, 4, "结果数量不变，失败的页面跳过但不删除");
  assert.match(enriched[0]!.content ?? "", /正文内容/);
  assert.equal(enriched[1]!.content, undefined, "抓取失败页面无正文");
  assert.equal(enriched[2]!.content, undefined, "超出 maxPages 不抓取");
  assert.equal(enriched[3]!.content, undefined);
  assert.ok(
    (enriched[0]!.content ?? "").length <= 80,
    "正文按 maxChars 截断",
  );
});

test("深度模式 attachPageContents：空结果与空正文处理", async () => {
  assert.deepEqual(await attachPageContents([], async () => "x", 2), []);
  const blank = [
    { title: "A", url: "https://a.example/", snippet: "s" },
  ];
  const noText = await attachPageContents(
    blank,
    async () => "   \n  ",
    2,
  );
  assert.equal(noText[0]!.content, undefined, "空正文视为未抓取");
});
