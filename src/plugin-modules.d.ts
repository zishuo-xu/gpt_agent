/**
 * 插件协议模块（myagent:*）的 ambient 类型声明。
 * 运行时由 plugin-loader 的解析器映射到真实实现；此处仅让类型检查
 * （含测试编译）能解析插件文件的 import，声明与实现导出保持同步。
 */
declare module "myagent:protocol" {
  import {
    definePluginTool,
    type PluginTool,
    type PluginToolConfigDecl,
    type PluginToolResult,
    type PluginToolRuntimeConfig,
  } from "./shared/plugin-tool.js";
  export {
    definePluginTool,
    type PluginTool,
    type PluginToolConfigDecl,
    type PluginToolResult,
    type PluginToolRuntimeConfig,
  };
}

declare module "myagent:html-text" {
  export function htmlToText(html: string): string;
  export function htmlToMainText(html: string): string;
}

declare module "myagent:sleep" {
  export function abortError(): DOMException;
  export function abortableSleep(
    ms: number,
    signal?: AbortSignal,
  ): Promise<void>;
}
