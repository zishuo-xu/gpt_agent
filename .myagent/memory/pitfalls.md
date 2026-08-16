# Pitfalls

- 2026-07-31: `runBash` (src/tools/bash.ts) 在超时或 AbortSignal 中止时先 kill 子进程树（整组 SIGTERM，500ms 后 SIGKILL 兜底），再以 `AbortError` 拒绝 Promise；不要期待 abort 后 resolve 出 `aborted: true` 的结果。测试中验证子进程被杀：命令内用单引号包裹 pid 文件路径（`writeFileSync('${pidFile}', ...)`），不要用 `JSON.stringify`（双引号会被 shell 的 `-e "..."` 双引号拆坏导致命令直接语法错误）。
- 2026-07-31 (已解决 2026-08-01): 基线 commit 1d3e6a7 之后 `pnpm typecheck` 与 `pnpm test`（93/93）均通过，src/web/app.ts 不再报 `Cannot find name 'message'`。
- 2026-08-01: Bash 工具存在 deny 规则，`rm -rf`（如 `/tmp/myagent-acceptance-g2`）会被直接拒绝：输出 `Permission denied: 命中 deny 规则，不能临时强制放行`，命令实际未执行；不要误以为命令成功运行过。
- [2026-08-10] IAB 浏览器 hash 路由切换（#a → #b）不重新加载 JS bundle，验证新前端功能时需 tab.reload() 才能看到最新构建。
- [2026-08-16] TypeScript 7：tsconfig 不再自动包含 @types/*，必须显式 `"types": ["node"]`（缺失时 process/fs 全部报 Cannot find name）；`baseUrl` 选项已被移除（web/tsconfig.json 的 paths 无需 baseUrl，相对 tsconfig 解析）。
- [2026-08-16] CI：pnpm/action-setup 不能同时显式 `version: 9` 与 package.json 的 `packageManager` 字段——action 报 Multiple versions 直接失败；去掉显式 version 让它读 packageManager 即可。GitHub 关闭 dependabot PR 时自动删除其远程分支（本地 refs 用 `git remote prune origin` 清理）。
- [2026-08-16] 全局配置（/trust 写入等）落盘在 `~/.myagent/config.jsonc`；`.myagent/local.jsonc` 是项目级个人配置，两者勿混。
- [2026-08-16] shell 批量替换小心 perl 数组插值：`perl -pi -e 's/x/@v7/g'` 中替换段 `@v7` 会被当数组插值成空——版本号等含 @ 的替换用 `\@` 转义或逐文件 Edit。
