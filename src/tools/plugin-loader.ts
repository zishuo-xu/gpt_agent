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
