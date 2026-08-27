# 真实开发任务验收

`pnpm eval:tasks` 运行三个无需依赖安装的开发任务 fixture，每个任务分别以 direct 和 plan 模式执行。每次运行会复制 fixture 到独立临时 workspace，使用 provider-free `ScriptedModelClient` 驱动真实 `AgentSession`、工具执行、Task Ledger 和验收链；Harness 外部的 oracle 通过 `node --test` 和必要的结构检查独立判断结果。因此 provider-free 报告只证明 Harness 管道，不代表模型智能，其中 token 与成本也是用于对比执行路径的模拟值。

```bash
pnpm eval:tasks
pnpm eval:tasks -- --mode plan --scenario bugfix-add --keep
```

报告默认写入 `tmp/eval-tasks/report.json` 和 `tmp/eval-tasks/report.md`。只有“外部验收通过、Agent 宣告完成，且 plan 模式的计划单元全部验证”才算可靠完成；否则命令返回非零状态并保留临时 workspace 供诊断。`--keep` 可保留所有 workspace。

真实模型入口是 `pnpm eval:tasks:real`。它在读取模型配置或发出网络请求前强制要求 `--confirm-cost`，并支持同样的 `--mode`、`--scenario` 与 `--keep` 参数；默认输出到 `tmp/eval-tasks-real/`。建议先用单场景、单模式控制成本：

```bash
pnpm eval:tasks:real -- --confirm-cost --mode direct --scenario bugfix-add
```

每个 run 记录外部 outcome、命令与结构验收证据、Agent 完成声明、可靠完成、错误完成、人工介入、验收轮次、工具调用/错误、tokens/cost/duration，以及 plan units 的状态计数；汇总提供总体完成率，以及 direct/plan 的可靠完成、介入、验收、平均 tokens、成本和耗时对比。
