import path from "node:path";
import type { DevTaskScenario } from "./types.js";

const p = (cwd: string, file: string) => path.join(cwd, file);
const todo = (ids: string[], contents: string[]) => ({
  todos: ids.map((id, i) => ({ id, content: contents[i] ?? id, status: "completed" as const })),
});

export const DEV_TASK_SCENARIOS: DevTaskScenario[] = [
  {
    id: "bugfix-add",
    title: "修复 add 的减法 bug",
    description: "修复 src/math.js 中 add 函数，使现有 node --test 测试通过。",
    fixture: "bugfix-add",
    check: "node --test test/*.test.js",
    planSteps: ["读取并定位 add 的实现与失败测试", "修复 add 的计算逻辑", "运行 node --test test 验证修复"],
    prepare: (cwd) => [
      { tool: "Read", target: p(cwd, "src/math.js"), args: { file_path: p(cwd, "src/math.js") } },
      { tool: "Edit", target: p(cwd, "src/math.js"), args: { file_path: p(cwd, "src/math.js"), old_string: "return a - b;", new_string: "return a + b;" } },
      { tool: "TodoWrite", target: "todo", args: todo(["plan-step-1", "plan-step-2", "plan-step-3"], ["定位实现", "修复计算逻辑", "运行测试"]) },
    ],
  },
  {
    id: "cross-file-greeting",
    title: "跨文件增加问候标点",
    description: "让 renderGreeting 输出带感叹号的问候语，并保持模块导入结构清晰。",
    fixture: "cross-file-greeting",
    check: "node --test test/*.test.js",
    planSteps: ["读取 greeting 与入口模块", "让 greeting 支持标点参数并由入口模块传入感叹号", "运行 node --test test 验证跨文件行为"],
    prepare: (cwd) => [
      { tool: "Read", target: p(cwd, "src/greeting.js"), args: { file_path: p(cwd, "src/greeting.js") } },
      { tool: "Read", target: p(cwd, "src/index.js"), args: { file_path: p(cwd, "src/index.js") } },
      { tool: "Edit", target: p(cwd, "src/greeting.js"), args: { file_path: p(cwd, "src/greeting.js"), old_string: "export function greeting(name) {\n  return `Hello, ${name}`;\n}", new_string: "export function greeting(name, punctuation = '.') {\n  return `Hello, ${name}${punctuation}`;\n}" } },
      { tool: "Edit", target: p(cwd, "src/index.js"), args: { file_path: p(cwd, "src/index.js"), old_string: "return greeting(name);", new_string: "return greeting(name, '!');" } },
      { tool: "TodoWrite", target: "todo", args: todo(["plan-step-1", "plan-step-2", "plan-step-3"], ["读取模块", "更新问候输出", "运行测试"]) },
    ],
  },
  {
    id: "refactor-normalize",
    title: "提取重复的 normalize 实现",
    description: "重构 src/strings.js，消除两个 normalizer 的重复实现，同时保持现有行为。",
    fixture: "refactor-normalize",
    check: "node --test test/*.test.js",
    planSteps: ["读取两个 normalizer 与测试", "提取共享实现并保持两个导出兼容", "运行 node --test test 验证行为不变"],
    prepare: (cwd) => [
      { tool: "Read", target: p(cwd, "src/strings.js"), args: { file_path: p(cwd, "src/strings.js") } },
      { tool: "Edit", target: p(cwd, "src/strings.js"), args: { file_path: p(cwd, "src/strings.js"), old_string: "export function normalizeForSearch(value) {\n  return value.trim().toLowerCase().replaceAll(' ', '-');\n}\n\nexport function normalizeForUrl(value) {\n  return value.trim().toLowerCase().replaceAll(' ', '-');\n}", new_string: "function normalize(value) {\n  return value.trim().toLowerCase().replaceAll(' ', '-');\n}\n\nexport function normalizeForSearch(value) {\n  return normalize(value);\n}\n\nexport function normalizeForUrl(value) {\n  return normalize(value);\n}" } },
      { tool: "TodoWrite", target: "todo", args: todo(["plan-step-1", "plan-step-2", "plan-step-3"], ["读取实现", "提取共享函数", "运行测试"]) },
    ],
  },
];

export function scenarioById(id: string): DevTaskScenario | undefined { return DEV_TASK_SCENARIOS.find((scenario) => scenario.id === id); }
