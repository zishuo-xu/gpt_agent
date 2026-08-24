# MyAgent 15 分钟 Demo

这个 demo 展示一个可验证的最小闭环：Agent 在隔离的临时工作区中发现一个失败的 TypeScript 测试，读取源码和测试，修改实现，再运行 Node 内置测试确认修复。

## 前置条件

- Node.js 22 或更高版本。
- pnpm 10（执行仓库命令时使用 `pnpm`，不要混用 npm）。
- 不需要外部 npm 包；demo workspace 只使用 Node 内置 `node:test` 和 `node:assert`。
- `pnpm demo` 使用 scripted model，不需要真实 provider 或 API Key。

## 推荐路径（约 15 分钟）

先安装并做一次健康检查：

```bash
pnpm install
pnpm run typecheck
pnpm test
```

然后用 demo runner 启动隔离任务：

```bash
pnpm demo
```

runner 的契约是：

1. 将 `examples/broken-ts/` 复制到新建的临时目录；
2. 在临时目录运行 `node --test tests/*.test.ts`，记录初始失败；
3. 用确定性 scripted model 驱动真实 `AgentSession`，传入机器可判定目标：

   ```text
   修复这个 TypeScript 项目中失败的测试。先阅读 tests/math.test.ts 和 src/math.ts，
   只修改必要文件，最后运行 node --test tests/*.test.ts。目标：测试通过。
   ```

4. 任务完成后再次运行同一测试，并检查临时目录中的 `src/math.ts` 已将减法改为加法；
5. 输出 session id、工具调用数、tokens、成本、耗时、改动文件和最终测试结果；
6. 清理临时目录（失败时保留路径用于诊断，或由 `MYAGENT_DEMO_KEEP=1` 显式保留）。

runner 不会直接把样例目录作为 cwd；成功时自动清理临时目录，失败时保留现场。设置 `MYAGENT_DEMO_KEEP=1` 可在成功时也保留。

## 手工复现 fixture

```bash
cd examples/broken-ts
node --test tests/*.test.ts       # 应失败：2 + 3 得到 -1
```

修复后再次执行同一命令，应看到 1 个 passing test、0 个 failing test。若当前 Node 版本不支持直接执行 `.ts`，不要修改样例；升级到 Node 22.6+ 后重试。

## Demo 验收标准

- 样例目录的 SHA-256 在运行前后相同；
- 初始测试失败，最终测试通过；
- Agent 的改动仅发生在临时复制目录；
- 输出机器可读的结果（至少包含 `status`、`testsPassed`、`testsFailed`、`changedFiles`、`tokens`、`cost`、`durationMs`）；
- 失败或审批超时时报告原因和临时目录路径，不把任务标记为成功。

## 两种安装方式

源码运行适合开发 MyAgent 本身：

```bash
pnpm install
pnpm run dev
# 或启动 Web：pnpm run web
```

构建后运行适合验证交付产物：

```bash
pnpm install
pnpm run build
node dist/cli.js
```

若需要在本机把 CLI 当作命令使用，可在构建后执行 `npm link`（它只建立本机全局链接，不发布包）：

```bash
pnpm run build
npm link
myagent --help
```

这是当前 `package.json` 的 bin 入口验证路径；项目仍标记为 private，不代表已提供 npm registry 发布包。

## 与 Eval 的关系

`pnpm eval` 运行 9 个确定性 Harness 场景，并生成 `tmp/eval/report.json` 与 `report.md`。它使用 scripted model 进入 CI，不会访问网络；真实模型基准仍是后续能力，届时必须显式记录 provider、model、日期和费用。
