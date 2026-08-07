import assert from "node:assert/strict";
import test from "node:test";
import {
  pluginToolRegistry,
  PluginToolRegistry,
} from "../shared/plugin-tool.js";
import {
  EXPLORE_TOOL_NAMES,
  getAllToolDefinitions,
  toolDefinitionsFor,
} from "./tool-definitions.js";

function pluginTool(name: string) {
  return {
    name,
    description: `${name} 插件说明`,
    inputSchema: { type: "object", properties: {} },
    async run() {
      return { summary: "ok" };
    },
  };
}

test("getAllToolDefinitions 含插件定义，main 全量注入", () => {
  // getAllToolDefinitions/toolDefinitionsFor 读全局单例，临时注册并清理
  pluginToolRegistry.register(pluginTool("WebFetch"));
  try {
    const all = getAllToolDefinitions();
    assert.ok(all.some((tool) => tool.name === "WebFetch"));
    assert.ok(all.some((tool) => tool.name === "Bash"));
    const main = toolDefinitionsFor(undefined);
    assert.deepEqual(main, all, "main 角色全量 = 内置 + 插件");
  } finally {
    pluginToolRegistry.clear();
  }
});

test("toolDefinitionsFor 按名过滤且不注入插件到只读 explore 集", () => {
  pluginToolRegistry.register(pluginTool("WebFetch"));
  try {
    const explore = toolDefinitionsFor(EXPLORE_TOOL_NAMES);
    assert.deepEqual(
      explore.map((tool) => tool.name),
      ["Read", "Grep", "Glob", "TodoWrite"],
      "explore 只读集不含插件工具",
    );
    const selected = toolDefinitionsFor(["Read", "WebFetch"] as never);
    assert.deepEqual(
      selected.map((tool) => tool.name),
      ["Read", "WebFetch"],
      "显式指定名时可包含插件",
    );
  } finally {
    pluginToolRegistry.clear();
  }
});
