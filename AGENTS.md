# AGENTS.md

## 项目定位

MyAgent 是一个本地编码 agent（local coding agent），面向长时间自主运行的编码任务。TypeScript + Node.js（≥22），单引擎双前端（CLI + Web）。

## 构建与验证命令

```bash
pnpm install          # 安装依赖
pnpm run typecheck    # 类型检查（core + web 两个 tsconfig）
pnpm test             # 运行测试（tsx --test：src 下 *.test.ts + web/src 下 *.test.tsx）
pnpm run build        # 构建（tsc 编译 core + vite 构建 web）
```

## 源码目录职责

| 目录 | 职责 |
| --- | --- |
| `src/core` | agent 主循环、会话管理、事件流、权限引擎、任务运行、分支 |
| `src/model` | 模型客户端（anthropic/openai 双协议 + thinking）、消息转换层、fallback 链、错误分类 |
| `src/tools` | 工具实现与执行器、插件加载（plugin-loader）、MCP 桥接（mcp-client/mcp-loader）、截断 |
| `src/shared` | 插件工具协议与注册表（PluginToolRegistry）、工具名枚举 |
| `src/web` | Web 后端（Hono 服务、会话 API） |
| `web/src` | Web 前端（React + Vite） |
| `.myagent/tools` | 项目级插件（WebSearch / WebFetch），协议见 docs/plugin-tools.md |

入口在 `src/cli.ts`。

## 改动后的检查路由

任何改动后必须依次运行：

1. `pnpm run typecheck`
2. `pnpm test`

涉及产物发布时追加 `pnpm run build`。全部通过后才算完成。
