import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  isValidPluginToolName,
  type PluginTool,
  type PluginToolRuntimeConfig,
  type PluginToolRegistry,
} from "../shared/plugin-tool.js";
import { isToolName } from "../shared/tool-names.js";

/**
 * 插件工具加载器（参照 Pi 扩展系统的目录发现，一期仅工具注册面）：
 * - 两层目录：~/.myagent/tools/（全局）+ <cwd>/.myagent/tools/（项目），同名项目层覆盖；
 * - 单层发现：*.ts / *.mjs / *.js（非递归）；
 * - 运行时 import()：dev/tsx 进程可直接加载 .ts；构建产物（无 tsx loader）下
 *   .ts 会失败，建议用 .mjs（原生 ESM 不依赖 loader）；
 * - 单个文件失败（import 错误、缺 name/description/run、与内置工具重名）跳过并
 *   记入 errors，不阻塞会话；
 * - 声明式配置（PluginTool.config）：loader 读取 plugins.json（两层浅合并）与
 *   环境变量，注册时闭包注入 run 第三参（config.section / config.env）。
 */

export interface PluginLoadReport {
  loaded: Array<{ name: string; source: string }>;
  errors: Array<{ file: string; message: string }>;
}

const PLUGIN_FILE_RE = /\.(ts|mjs|js)$/i;

/**
 * TS 插件运行时：注册 tsx 的 ESM loader，让 .ts 插件与其相对 src 的
 * `.js` → `.ts` import（如 `../../src/shared/plugin-tool.js`）在 dist 部署
 * （node dist/cli.js，无 tsx 包裹）下同样可解析。幂等；tsx 缺失时静默降级
 * （Node ≥22.6 原生 type-stripping 可加载自包含 .ts 插件，src 相对 import
 * 的插件在精简安装下不可用，属预期边界）。
 */
let tsRuntimeReady = false;
async function ensureTsRuntime(): Promise<void> {
  if (tsRuntimeReady) return;
  try {
    const { register } = await import("tsx/esm/api");
    register();
  } catch {
    // tsx 不可用：降级原生 import
  }
  tsRuntimeReady = true;
}

/**
 * myagent:* 稳定 specifier 解析（插件协议稳定化）：插件 import
 * "myagent:protocol" / "myagent:html-text" / "myagent:sleep"，由本解析器翻译为
 * 插件所在项目根的 src/*.ts 文件，与部署方式（tsx / node dist）和 src 相对路径
 * 解耦。注册在 tsx 之后（后注册先调用）：myagent:* 先命中本解析器，其余委派。
 *
 * 两条注册路径：
 * - Node ≥22.15 用 registerHooks（同步契约，内联函数，见 resolveMyagentSpecifier）；
 * - 更早版本用 register + data URL（自包含 hook 模块，逻辑与内联版保持同步）。
 * 都通过 nextResolve 委派翻译后的路径，不直接返回结果对象（registerHooks 下
 * 非委派返回要求 shortCircuit，会截断 tsx 的解析链）。
 */
const MYAGENT_MODULE_MAP: Record<string, string> = {
  "myagent:protocol": "src/shared/plugin-tool.ts",
  "myagent:html-text": "src/tools/html-text.ts",
  "myagent:sleep": "src/utils/sleep.ts",
};

let specifierResolverReady = false;

function resolveMyagentSpecifier(
  specifier: string,
  context: { parentURL?: string },
  nextResolve: (
    specifier: string,
    context?: { parentURL?: string },
  ) => { url: string } | Promise<{ url: string }>,
): { url: string } | Promise<{ url: string }> {
  if (!specifier.startsWith("myagent:")) {
    return nextResolve(specifier, context);
  }
  const rel = MYAGENT_MODULE_MAP[specifier];
  if (!rel) {
    throw new Error(
      `未知 myagent specifier: ${specifier}（白名单：${Object.keys(MYAGENT_MODULE_MAP).join(" / ")}）`,
    );
  }
  const parent = context.parentURL;
  if (!parent) {
    throw new Error("myagent:* 只能在插件模块内使用（缺少 parentURL）");
  }
  // 插件文件 <root>/.myagent/tools/xx.ts → 上两级 = 项目根
  const root = new URL("../..", new URL(".", parent));
  return nextResolve(new URL(rel, root).href, context);
}

/** data URL 版 hook 模块（Node <22.15 的 register 回退路径）：与内联版逻辑一致 */
const MYAGENT_RESOLVER_DATA_URL = `data:text/javascript,${encodeURIComponent(
  `const MODULES = ${JSON.stringify(MYAGENT_MODULE_MAP)};\n` +
    `export async function resolve(specifier, context, nextResolve) {\n` +
    `  if (!specifier.startsWith("myagent:")) return nextResolve(specifier, context);\n` +
    `  const rel = MODULES[specifier];\n` +
    `  if (!rel) throw new Error("未知 myagent specifier: " + specifier + "（白名单：" + Object.keys(MODULES).join(" / ") + "）");\n` +
    `  if (!context.parentURL) throw new Error("myagent:* 只能在插件模块内使用（缺少 parentURL）");\n` +
    `  const root = new URL("../..", new URL(".", context.parentURL));\n` +
    `  return nextResolve(new URL(rel, root).href, context);\n` +
    `}\n`,
)}`;

/**
 * 幂等注册 myagent:* 解析器（进程级）。loadOne 会隐式调用；
 * 直接 import 插件源文件的场景（如单测）需先显式调用：
 *   await ensureSpecifierResolver();
 *   const mod = await import("../../.myagent/tools/xx.js");
 */
export async function ensureSpecifierResolver(): Promise<void> {
  if (specifierResolverReady) return;
  try {
    const moduleApi = (await import("node:module")) as {
      registerHooks?: (hooks: {
        resolve: (
          specifier: string,
          context: { parentURL?: string },
          nextResolve: (
            specifier: string,
            context?: { parentURL?: string },
          ) => { url: string } | Promise<{ url: string }>,
        ) => { url: string } | Promise<{ url: string }>;
      }) => void;
      register: (specifier: string, parentURL: string) => void;
    };
    if (typeof moduleApi.registerHooks === "function") {
      // @types/node 将 registerHooks 的 resolve 声明为纯同步（ResolveHookSync），
      // 但运行时同步 hook 可返回 thenable（委派链下游 tsx 为异步 hook，实测可用）
      moduleApi.registerHooks({
        resolve: resolveMyagentSpecifier,
      } as never);
    } else {
      moduleApi.register(MYAGENT_RESOLVER_DATA_URL, import.meta.url);
    }
  } catch (error) {
    console.error(
      `[plugins] myagent:* 解析器注册失败：${(error as Error).message}（插件可用相对路径写法）`,
    );
  }
  specifierResolverReady = true;
}

/** 读取两层 plugins.json（全局 + 项目，项目层覆盖），缺失返回空对象 */
export async function readPluginsJson(
  homeDir: string,
  cwd: string,
): Promise<Record<string, unknown>> {
  let merged: Record<string, unknown> = {};
  for (const file of [
    path.join(homeDir, ".myagent", "plugins.json"),
    path.join(cwd, ".myagent", "plugins.json"),
  ]) {
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as Record<
        string,
        unknown
      >;
      merged = { ...merged, ...raw };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(
          `[plugins] 读取 ${file} 失败：${(error as Error).message}`,
        );
      }
    }
  }
  return merged;
}

/** 按插件声明解析运行时配置（plugins.json 段 + 环境变量） */
export function resolvePluginConfig(
  tool: Pick<PluginTool, "config">,
  pluginsJson: Record<string, unknown>,
): PluginToolRuntimeConfig | undefined {
  const decl = tool.config;
  if (!decl) return undefined;
  const runtime: PluginToolRuntimeConfig = {};
  if (decl.section) {
    runtime.section = pluginsJson[decl.section];
  }
  if (decl.env) {
    const env: Record<string, string> = {};
    for (const [envName, paramName] of Object.entries(decl.env)) {
      const value = process.env[envName]?.trim();
      if (value) env[paramName] = value;
    }
    runtime.env = env;
  }
  return runtime;
}

async function collectToolFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && PLUGIN_FILE_RE.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => path.join(dir, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function loadOne(file: string): Promise<PluginTool> {
  await ensureTsRuntime();
  await ensureSpecifierResolver();
  const module = (await import(pathToFileURL(file).href)) as {
    default?: unknown;
  };
  const tool = module.default;
  if (!tool || typeof tool !== "object") {
    throw new Error("文件未 default 导出一个插件工具对象");
  }
  const candidate = tool as Partial<PluginTool>;
  if (
    typeof candidate.name !== "string" ||
    !isValidPluginToolName(candidate.name)
  ) {
    throw new Error(
      `插件缺少合法工具名（字母开头，仅字母/数字/_/-）：${String(candidate.name)}`,
    );
  }
  if (isToolName(candidate.name)) {
    throw new Error(`插件工具名与内置工具冲突：${candidate.name}`);
  }
  if (
    typeof candidate.description !== "string" ||
    candidate.description.length === 0 ||
    typeof candidate.run !== "function"
  ) {
    throw new Error(`插件“${candidate.name}”缺少 description 或 run 实现`);
  }
  return candidate as PluginTool;
}

export async function loadPluginTools(
  homeDir: string,
  cwd: string,
  registry: PluginToolRegistry,
): Promise<PluginLoadReport> {
  const report: PluginLoadReport = { loaded: [], errors: [] };
  // 声明式配置：plugins.json 读一次，供全部插件解析
  const pluginsJson = await readPluginsJson(homeDir, cwd);
  // 全局层先注册，项目层后注册覆盖同名（与 config mergeLayers 语义一致）
  for (const dir of [
    path.join(homeDir, ".myagent", "tools"),
    path.join(cwd, ".myagent", "tools"),
  ]) {
    for (const file of await collectToolFiles(dir)) {
      try {
        const tool = await loadOne(file);
        const runtimeConfig = resolvePluginConfig(tool, pluginsJson);
        registry.register(
          runtimeConfig
            ? {
                ...tool,
                run: (args, signal) =>
                  tool.run(args, signal, runtimeConfig),
              }
            : tool,
          file,
        );
        // 同名覆盖：移除此前（全局层）的同名条目，保持报告与实际注册一致
        const previous = report.loaded.findIndex(
          (item) => item.name === tool.name,
        );
        if (previous >= 0) report.loaded.splice(previous, 1);
        report.loaded.push({ name: tool.name, source: file });
      } catch (error) {
        report.errors.push({
          file,
          message: error instanceof Error ? error.message : "加载失败",
        });
      }
    }
  }
  // 持久化的禁用状态（plugins.json 的 pluginDisabled 段）：全部注册完成后应用
  const disabledNames = Array.isArray(pluginsJson.pluginDisabled)
    ? (pluginsJson.pluginDisabled as unknown[]).filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  for (const name of disabledNames) {
    registry.setEnabled(name, false);
  }
  return report;
}

/**
 * 持久化插件禁用状态：写入 plugins.json（全局层）的 pluginDisabled 段。
 * enabled=false 时把名字加入数组（去重），true 时移除。只修改该文件自身的
 * pluginDisabled 字段，不动其他段（webSearch/mcpServers 等）。
 */
export async function savePluginDisabled(
  homeDir: string,
  name: string,
  enabled: boolean,
): Promise<void> {
  const file = path.join(homeDir, ".myagent", "plugins.json");
  const raw = (await readRawJson(file)) as Record<string, unknown>;
  const list = Array.isArray(raw.pluginDisabled)
    ? (raw.pluginDisabled as unknown[]).filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  const next = enabled
    ? list.filter((item) => item !== name)
    : list.includes(name)
      ? list
      : [...list, name];
  await writeFile(
    file,
    `${JSON.stringify({ ...raw, pluginDisabled: next }, null, 2)}\n`,
    "utf8",
  );
}

async function readRawJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
