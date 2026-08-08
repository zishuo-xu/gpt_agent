import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginToolRegistry } from "../shared/plugin-tool.js";
import { loadPluginTools } from "./plugin-loader.js";

async function fixture(): Promise<{
  home: string;
  project: string;
  registry: PluginToolRegistry;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-plugins-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(home, ".myagent", "tools"), { recursive: true });
  await mkdir(path.join(project, ".myagent", "tools"), { recursive: true });
  return { home, project, registry: new PluginToolRegistry() };
}

const PLUGIN_TMPL = (
  name: string,
  extra: string,
) => `import { definePluginTool } from ${JSON.stringify(
  path.resolve("src/shared/plugin-tool.js"),
)};
export default definePluginTool({
  name: ${JSON.stringify(name)},
  description: "${name} 说明",
  inputSchema: { type: "object" },
  ${extra}
});
`;

test("加载器：两层目录发现，项目层覆盖全局同名", async () => {
  const { home, project, registry } = await fixture();
  await writeFile(
    path.join(home, ".myagent", "tools", "fetch.ts"),
    PLUGIN_TMPL("Fetch", "async run() { return { summary: 'global' }; }"),
    "utf8",
  );
  await writeFile(
    path.join(project, ".myagent", "tools", "fetch.ts"),
    PLUGIN_TMPL("Fetch", "async run() { return { summary: 'project' }; }"),
    "utf8",
  );
  await writeFile(
    path.join(project, ".myagent", "tools", "notes.ts"),
    PLUGIN_TMPL("Notes", "async run() { return { summary: 'notes' }; }"),
    "utf8",
  );

  const report = await loadPluginTools(home, project, registry);
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  assert.deepEqual(
    report.loaded.map((item) => item.name).sort(),
    ["Fetch", "Notes"],
  );
  // 同名项目层覆盖：Fetch 的来源文件是项目目录
  const fetchSource = report.loaded.find((item) => item.name === "Fetch")!.source;
  assert.ok(fetchSource.includes(project), "项目层应覆盖全局层");

  const result = await registry.execute(
    "Fetch",
    {},
    new AbortController().signal,
  );
  assert.equal(result.summary, "project");
});

test("加载器：坏文件跳过不阻塞，缺目录返回空", async () => {
  const { home, project, registry } = await fixture();
  await writeFile(
    path.join(project, ".myagent", "tools", "broken.ts"),
    "export default { name: 'Broken' };\n", // 缺 run
    "utf8",
  );
  await writeFile(
    path.join(project, ".myagent", "tools", "syntax-error.ts"),
    "export default { {{{;\n",
    "utf8",
  );
  await writeFile(
    path.join(project, ".myagent", "tools", "collides.ts"),
    PLUGIN_TMPL("Read", "async run() { return { summary: 'x' }; }"), // 内置名冲突
    "utf8",
  );
  await writeFile(
    path.join(project, ".myagent", "tools", "good.ts"),
    PLUGIN_TMPL("Good", "async run() { return { summary: 'ok' }; }"),
    "utf8",
  );

  const report = await loadPluginTools(home, project, registry);
  assert.deepEqual(report.loaded.map((item) => item.name), ["Good"]);
  assert.equal(report.errors.length, 3);
  assert.ok(report.errors.some((e) => /内置工具冲突/.test(e.message)));
  assert.ok(report.errors.some((e) => /syntax-error/.test(e.file)));

  // 无插件目录的场景
  const emptyHome = await mkdtemp(path.join(os.tmpdir(), "myagent-plugins-empty-"));
  const empty = await loadPluginTools(emptyHome, emptyHome, new PluginToolRegistry());
  assert.deepEqual(empty.loaded, []);
  assert.deepEqual(empty.errors, []);
  await rm(emptyHome, { recursive: true, force: true });
});

test("加载器：声明式配置注入 run 第三参（plugins.json 两层合并 + 环境变量）", async () => {
  const { home, project, registry } = await fixture();
  // 全局层 plugins.json + 项目层覆盖（webSearch 段项目层合并）
  await writeFile(
    path.join(home, ".myagent", "plugins.json"),
    JSON.stringify({
      webSearch: { provider: "tavily", apiKey: "tvly-global" },
    }),
    "utf8",
  );
  await writeFile(
    path.join(project, ".myagent", "plugins.json"),
    JSON.stringify({
      webSearch: { provider: "searxng", baseUrl: "http://127.0.0.1:8080/" },
    }),
    "utf8",
  );
  process.env.MYAGENT_TEST_TOKEN = "env-token";
  try {
    await writeFile(
      path.join(project, ".myagent", "tools", "cfg.ts"),
      PLUGIN_TMPL(
        "CfgTool",
        `config: { section: "webSearch", env: { MYAGENT_TEST_TOKEN: "token" } },
  async run(args, signal, config) {
    return { summary: "cfg", details: { section: config?.section, token: config?.env?.token } };
  }`,
      ),
    );
    const report = await loadPluginTools(home, project, registry);
    assert.equal(report.errors.length, 0);
    const result = await registry.execute(
      "CfgTool",
      {},
      new AbortController().signal,
    );
    const details = result.details as {
      section?: { provider?: string; baseUrl?: string };
      token?: string;
    };
    // 项目层覆盖全局层（searxng 而非 tavily）
    assert.equal(details.section?.provider, "searxng");
    assert.equal(details.section?.baseUrl, "http://127.0.0.1:8080/");
    // 环境变量注入
    assert.equal(details.token, "env-token");
  } finally {
    delete process.env.MYAGENT_TEST_TOKEN;
  }
});

test("加载器：无 config 声明的插件 run 第三参为 undefined", async () => {
  const { home, project, registry } = await fixture();
  await writeFile(
    path.join(project, ".myagent", "tools", "plain.ts"),
    PLUGIN_TMPL(
      "PlainTool",
      `async run(args, signal, config) {
    return { summary: "plain", details: { config: config ?? null } };
  }`,
    ),
  );
  await loadPluginTools(home, project, registry);
  const result = await registry.execute(
    "PlainTool",
    {},
    new AbortController().signal,
  );
  assert.deepEqual(
    (result.details as { config: unknown }).config,
    null,
    "无声明时第三参为 undefined",
  );
});
