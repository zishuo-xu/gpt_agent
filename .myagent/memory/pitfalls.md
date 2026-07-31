# Pitfalls

- 2026-07-31: `runBash` (src/tools/bash.ts) 在超时或 AbortSignal 中止时先 kill 子进程树（整组 SIGTERM，500ms 后 SIGKILL 兜底），再以 `AbortError` 拒绝 Promise；不要期待 abort 后 resolve 出 `aborted: true` 的结果。测试中验证子进程被杀：命令内用单引号包裹 pid 文件路径（`writeFileSync('${pidFile}', ...)`），不要用 `JSON.stringify`（双引号会被 shell 的 `-e "..."` 双引号拆坏导致命令直接语法错误）。
- 2026-07-31 (unconfirmed): `pnpm typecheck` 目前在 src/web/app.ts 报 `Cannot find name 'message'`（第 173/174/181/197 行，疑似应为 `task`），与 src/tools 改动无关，属存量问题。
