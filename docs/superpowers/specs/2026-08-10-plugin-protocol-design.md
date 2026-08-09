# 插件协议稳定化：myagent:* 稳定 specifier — 设计文档

> 日期：2026-08-10
> 分支：zcode-remote-api（基于 e8e0e19 = 合并后 main）
> 状态：方案已确认（稳定 specifier 全解，技术可行性已验证）

---

## 1. 背景与问题

插件（`.myagent/tools/*.ts`）通过相对路径引用项目内部模块：

```ts
import { definePluginTool } from "../../src/shared/plugin-tool.js";  // 实际文件是 .ts
import { htmlToMainText } from "../../src/tools/html-text.js";
import { abortableSleep } from "../../src/utils/sleep.js";
```

问题：`.js` 后缀指向 `.ts` 文件，依赖 tsx 的 `.js→.ts` 解析。CLI（tsx 运行）正常；`node dist/cli.js` 部署下解析失败 → 插件 0 加载（已修第一层：loader 注册 tsx，见 `fe51e9b`）。但**根因未除**：插件绑定"项目内部路径 + 解析环境"，任何部署方式变化或项目重构都可能再断。

## 2. 目标

插件引用项目公共代码（协议 + 工具）时，**不写路径**，使用稳定的 `myagent:*` specifier，由 loader 统一解析。插件写法与部署方式、项目内部结构解耦。

## 3. 方案（已确认）：稳定 specifier 全解

技术可行性已验证：`module.register` 链式注册（tsx 先、自定义 resolver 后 → 后注册先调用），`myagent:protocol` / `myagent:html-text` / `myagent:sleep` 在纯 node 下解析成功（2026-08-10 实测）。

## 4. 设计

### 4.1 specifier 白名单

| specifier | 解析目标（项目根内） |
|---|---|
| `myagent:protocol` | `src/shared/plugin-tool.ts` |
| `myagent:html-text` | `src/tools/html-text.ts` |
| `myagent:sleep` | `src/utils/sleep.ts` |

扩展方式：resolver 白名单加行（协议内部变化，不影响已发布插件）。

### 4.2 resolver 实现

- 自定义 `resolve` hook：specifier 以 `myagent:` 开头 → 查白名单 → 翻译为 `file://` URL → `nextResolve` 委托 tsx/Node 继续解析；其余原样委托
- 未知 `myagent:*` → 抛明确错误（进插件加载 errors，插件面板可见）
- **项目根推导**：从 `context.parentURL`（插件文件位置）向上两级——插件在 `<root>/.myagent/tools/xx.ts`，root 即项目根。多项目天然安全（每个插件解析到自身项目的 src）
- **hook 代码以 data URL 内联注册**：不落独立文件，避免 tsc 构建不含 `.mjs` 的问题
- **注册时机**：plugin-loader `loadOne` 前、`ensureTsRuntime` 之后，幂等注册一次（进程级）
- **Node 版本兼容**：优先 `module.registerHooks`（Node 26 推荐），不可用回退 `module.register`（Node 22 有弃用警告但不失效）
- **解析目标统一 `src/*.ts`**：tsx 已注册保证可加载；Node ≥22.6 原生 type-stripping 也能加载纯类型模块——即使 tsx 缺失，`myagent:protocol` 这类自包含模块仍可用

### 4.3 示例插件改造

`.myagent/tools/web-search.ts` / `web-fetch.ts`（git 跟踪）：

```ts
import { definePluginTool, type PluginToolRuntimeConfig } from "myagent:protocol";
import { htmlToMainText, htmlToText } from "myagent:html-text";
import { abortableSleep } from "myagent:sleep";
```

### 4.4 兼容性

- 旧相对路径写法**继续可用**（tsx 注册兜底），不强制迁移
- 文档注明推荐 `myagent:*` 写法

## 5. 测试策略

| 层 | 覆盖点 |
|---|---|
| 单测（plugin-loader.test.ts） | fixture 项目根建 `src/shared|tools|utils` 空壳模块；插件以 `myagent:protocol` / `myagent:html-text` / `myagent:sleep` import → 加载成功、run 可调用；未知 `myagent:unknown` → errors 含明确信息；旧相对路径插件仍加载 |
| 现有测试 | 不破坏（PLUGIN_TMPL 绝对路径写法保持） |
| dist 集成验证 | `pnpm build` 后纯 node 跑 `loadPluginTools` → 示例插件（新写法）loaded、0 errors |
| 服务级 | 重启 worktree 服务 → 插件面板 loaded（真实环境，插件面板即加载） |
| e2e 回归 | desktop 套件（插件面板相关用例不受影响） |

## 6. 产出物

- `src/tools/plugin-loader.ts`（+ensureSpecifierResolver + data URL resolver）
- `.myagent/tools/web-search.ts`、`web-fetch.ts`（import 改 myagent:*）
- `docs/plugin-tools.md`（插件写法规范：myagent:* 推荐 + 兼容说明）
- 测试：`src/tools/plugin-loader.test.ts` 扩展
- 本文档 `docs/superpowers/specs/2026-08-10-plugin-protocol-design.md`

## 7. 不做（范围外）

- 不引入 npm 包/外部依赖
- 不改造 PluginToolRegistry / definePluginTool 语义（协议 API 不变，仅引用方式变）
- 不做插件构建/打包（插件仍是源码文件）
