#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path, { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInterface,
  emitKeypressEvents,
  type Key,
} from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { ConfigService, type ConfigScope } from "./config/service.js";
import {
  getConfigValue,
  setConfigValue,
} from "./shared/config-path.js";
import type { ModelRole } from "./config/schema.js";
import { AgentSessionManager } from "./core/session-manager.js";
import { AgentSession } from "./core/session.js";
import {
  createEventRenderer,
  summarizeEvent,
  type ApprovalState,
} from "./cli-render.js";
import {
  coerceConfigValue,
  formatEffectiveConfig,
  isApprovalAnswer,
  parseApprovalAnswer,
  parseConfigSetLine,
  shouldWarnUntrustedProject,
} from "./cli-utils.js";
import {
  parseRunCommand,
  type RunTaskOptions,
} from "./core/run-task.js";
import type {
  PermissionMode,
  SessionBranch,
} from "./core/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg: { version: string } = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
);
const VERSION: string = pkg.version;

// 兜底：任何遗漏的 async rejection 都会在此暴露（Node 默认行为是直接终止，
// 保留默认退出但先输出可诊断的堆栈与上下文；正常路径的 rejection 均已在上游 catch）
process.on("unhandledRejection", (reason) => {
  console.error(
    `[cli] 未处理的 Promise rejection：${
      reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason)
    }`,
  );
});

/** --port <n>：Web 端口覆盖（测试与多实例场景用） */
const webPortArg = process.argv.indexOf("--port");
const webPort =
  webPortArg >= 0 ? Number(process.argv[webPortArg + 1]) : undefined;

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

// --force：跳过单实例写锁（同项目多进程并发写会损坏事件流，仅崩溃残留确认后使用）
const force = process.argv.includes("--force");

// 守护进程模式：--daemon 让 Web 服务器脱离终端常驻（detach + pid 文件 + 日志重定向）；
// --daemon-stop 按 pid 文件停止。
if (process.argv.includes("--web") && process.argv.includes("--daemon")) {
  await startDaemonWeb();
} else if (process.argv.includes("--web") && process.argv.includes("--daemon-stop")) {
  await stopDaemonWeb();
} else if (process.argv.includes("--web")) {
  const { startWebServer } = await import("./web/server.js");
  await startWebServer({
    cwd: process.cwd(),
    ...(webPort ? { port: webPort } : {}),
  });
} else {
  await runCli().catch((error) => {
    process.stderr.write(
      `启动失败：${error instanceof Error ? error.message : "未知错误"}\n`,
    );
    process.exit(1);
  });
}

/**
 * 守护进程化：spawn 自身（--web）detached 运行，stdout/stderr 重定向到
 * <stateDir>/web.log，pid 写入 <stateDir>/web.pid。父进程立即退出。
 */
async function startDaemonWeb(): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { mkdir } = await import("node:fs/promises");
  const os = await import("node:os");
  const stateRoot = path.join(os.homedir(), ".myagent");
  const daemonDir = path.join(stateRoot, "daemon");
  await mkdir(daemonDir, { recursive: true });
  const logPath = path.join(daemonDir, "web.log");
  const pidPath = path.join(daemonDir, "web.pid");

  // 日志轮转：web.log 超过 5MB 时改名 web.log.1（保留最近一份），再开新日志
  const fsSync = await import("node:fs");
  try {
    if (fsSync.statSync(logPath).size > 5 * 1024 * 1024) {
      fsSync.renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // 日志不存在或轮转失败：继续以追加方式打开
  }
  const logFd = fsSync.openSync(logPath, "a");
  const child = spawn(
    process.execPath,
    [
      // 复用当前进程的加载器（tsx 的 preflight/import 钩子在 execArgv）与入口参数，
      // 仅剔除 --daemon：构建后（dist/cli.js）execArgv 为空，参数即 [cli.js, --web]
      ...process.execArgv,
      ...process.argv.slice(1).filter((arg) => arg !== "--daemon"),
    ],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    },
  );
  child.unref();
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(pidPath, String(child.pid) + "\n"),
  );
  console.log(`MyAgent Web 已作为守护进程启动（pid ${child.pid}）`);
  console.log(`  日志：${logPath}`);
  console.log(`  停止：myagent --web --daemon-stop`);
}

async function stopDaemonWeb(): Promise<void> {
  const os = await import("node:os");
  const pidPath = path.join(os.homedir(), ".myagent", "daemon", "web.pid");
  const { readFile, unlink } = await import("node:fs/promises");
  try {
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("pid 无效");
    process.kill(pid, "SIGTERM");
    await unlink(pidPath).catch(() => undefined);
    console.log(`已向守护进程 ${pid} 发送停止信号。`);
  } catch (error) {
    console.log(
      `守护进程未在运行或已停止：${error instanceof Error ? error.message : "未知错误"}`,
    );
  }
}

async function runCli(): Promise<void> {
  const cwd = process.cwd();
  const { timingMark, timingReport } = await import("./utils/timing.js");
  const configService = new ConfigService({ cwd });
  // 启动时清理过期超限落盘日志（尽力而为，不阻塞启动）
  const { cleanupStaleBashLogs } = await import("./tools/bash.js");
  void cleanupStaleBashLogs();
  // 缓存 miss 提示开关（behavior.showCacheMissNotices，热生效；默认关闭）
  let showCacheMissNotices = false;
  const initialConfig = await configService.readEffective();
  timingMark("config 加载");
  showCacheMissNotices =
    initialConfig.behavior?.showCacheMissNotices === true;
  configService.onChange((config) => {
    showCacheMissNotices = config.behavior?.showCacheMissNotices === true;
  });
  // 信任项目引导（两段式）：trust 档 + 未标记目录时提示一次——
  // 显式信任声明，不改变权限档位语义；/trust 标记或设置页可消除提示
  if (shouldWarnUntrustedProject(initialConfig, cwd)) {
    process.stderr.write(
      "注意：当前目录未标记为信任项目，而权限档为 trust（写操作与命令将自动执行）。\n" +
        "确认该目录可信可执行 /trust 标记（写入全局配置，Web 设置页可管理）。\n",
    );
  }
  const manager = new AgentSessionManager({
    cwd,
    configService,
    ...(force ? { skipLock: true } : {}),
  });
  await manager.restore();
  timingMark("restore");
  let session = await manager.createSession({
    title: "CLI 会话",
    mode: "normal",
  });
  timingMark("createSession");
  process.stderr.write(timingReport());
  const readline = createInterface({
    input,
    output,
    prompt: "myagent › ",
  });
  const approvalState: ApprovalState = { pendingCallId: "" };
  let pendingRun: RunTaskOptions | undefined;
  let closed = false;

  /** readline 关闭后（/exit、管道 EOF 自动关闭）不再 prompt，避免 ERR_USE_AFTER_CLOSE */
  const safePrompt = (newline = false) => {
    if (closed) return;
    try {
      readline.prompt(newline);
    } catch {
      // readline 已被关闭：prompt 抛 ERR_USE_AFTER_CLOSE，忽略即可
    }
  };
  /** 斜杠命令串行执行链（管道连续输入时的顺序保证） */
  let commandChain: Promise<void> = Promise.resolve();

  let unsubscribe = subscribeToSession(session);

  readline.on("line", (raw) => {
    const line = raw.trim();
    if (!line) {
      safePrompt();
      return;
    }
    if (approvalState.pendingCallId && isApprovalAnswer(line)) {
      const answer = parseApprovalAnswer(line);
      const resolved = session.resolvePermission(
        approvalState.pendingCallId,
        answer,
      );
      if (resolved) approvalState.pendingCallId = "";
      safePrompt();
      return;
    }
    if (pendingRun && ["y", "yes", "n", "no"].includes(line.toLowerCase())) {
      const confirmed = ["y", "yes"].includes(line.toLowerCase());
      const task = pendingRun;
      pendingRun = undefined;
      if (confirmed) startRun(task);
      else output.write("已取消无人值守任务。\n");
      safePrompt();
      return;
    }
    if (line.startsWith("/")) {
      // 串行执行命令：管道/脚本连续输入多条命令时避免读-改-写竞态
      //（如连续 /config set 互相覆盖）与 readline 关闭后的 prompt 崩溃
      commandChain = commandChain.then(() => handleCommand(line));
      return;
    }
    void session.sendInput(line).catch((error) => {
      output.write(
        `\n任务启动失败：${error instanceof Error ? error.message : "未知错误"}\n`,
      );
      safePrompt(true);
    });
    safePrompt();
  });

  readline.on("SIGINT", () => {
    if (session.interrupt()) {
      output.write("\n正在中止模型与当前工具…\n");
      safePrompt(true);
      return;
    }
    void closeCli();
  });

  emitKeypressEvents(input, readline);
  if (input.isTTY) input.setRawMode(true);
  const onKeypress = (_text: string, key: Key) => {
    if (key.name !== "escape") return;
    if (session.interrupt()) {
      output.write("\nEsc：正在中止模型与当前工具…\n");
      safePrompt(true);
    }
  };
  input.on("keypress", onKeypress);

  output.write(
    `\n◆ MyAgent v0.1 · 会话 #${session.id}\n` +
      `  ${cwd} · ${session.summary().permissionMode} 档\n` +
      "  直接输入任务；运行中继续输入会排队；Esc 硬中止。\n" +
      "  输入 /help 查看命令。\n\n",
  );
  safePrompt();

  async function handleCommand(line: string): Promise<void> {
    if (line === "/exit") {
      await closeCli();
      return;
    }
    if (line === "/help") {
      output.write(
        [
          "",
          "/permission <strict|normal|trust>  切换权限档",
          "/steer <指令>                      插队打断：当前工具完成后立即转向新指令",
          "/run <任务> [--goal ... --bounds ... --until ... --budget ... --permission ...]",
          "/cost                              查看当前 token 统计",
          "/sessions                          查看全部会话",
          "/switch <id>                       切换/恢复会话",
          "/resume                            续跑当前会话中断的任务（进程重启后）",
          "/compact                           立即压缩当前会话上下文",
          "/tree                              查看会话分支树",
          "/branch <seq> [label]              从指定事件 seq 分裂新分支",
          "/goto <branchId>                    回溯切换到已有分支",
          "/timeline                          列出最近事件（查看分支点 seq）",
          "/label <seq> <名称>                给事件打书签；/labels 查看；/unlabel <seq> 移除",
          "/init                              只读扫描并生成 AGENTS.md 草稿",
          "/review                            对最近一次完成运行独立审查（任务验收链）",
          "/config [global|project]           查看生效配置摘要或指定作用域配置",
          "/config set <key> <value> [global|project] 修改配置项",
          "/model                             查看角色模型；/model main <provider>/<model> 切换（热生效）",
          "/trust                             将当前目录标记为信任项目（显式声明，trust 档启动不再提示）",
          "/allow [once|session|project|global] 回答并选择记忆范围",
          "/deny [留言]                       拒绝，可附纠正意见",
          "/exit                              退出",
          "",
          "运行中直接输入会作为软打断排队；Esc 立即中止模型与工具。",
          "",
        ].join("\n"),
      );
      safePrompt();
      return;
    }
    if (line.startsWith("/permission ")) {
      const mode = line.slice("/permission ".length) as PermissionMode;
      if (!["strict", "normal", "trust"].includes(mode)) {
        output.write("权限档必须是 strict、normal 或 trust。\n");
      } else {
        session.setPermissionMode(mode);
        output.write(`已切换到 ${mode} 档。\n`);
      }
      safePrompt();
      return;
    }
    if (line === "/run" || line.startsWith("/run ")) {
      try {
        const task = parseRunCommand(line);
        if (task.at || task.everyMinutes) {
          // 定时规格由 Web 服务的调度器消费；CLI 是前台进程，本次立即执行一次
          output.write(
            "⚠ 定时规格（--at/--every）仅 Web 服务端生效；本次立即执行一次。\n",
          );
        }
        if (task.hardRules.length > 0) {
          pendingRun = task;
          output.write(
            "\n任务边界将编译为以下临时 deny 规则：\n" +
              task.hardRules
                .map((rule) => `  - ${rule.pattern}`)
                .join("\n") +
              (task.semanticBounds.length
                ? `\n软语义边界（不能由路径权限完全保证）：${task.semanticBounds.join("；")}`
                : "") +
              "\n确认后开始？输入 y/n。\n",
          );
        } else {
          startRun(task);
        }
      } catch (error) {
        output.write(
          `${error instanceof Error ? error.message : "/run 参数无效"}\n`,
        );
      }
      safePrompt();
      return;
    }
    if (line.startsWith("/steer ")) {
      const text = line.slice("/steer ".length).trim();
      if (!text) {
        output.write("用法：/steer <新指令>\n");
      } else if (!session.isProcessing()) {
        output.write("当前没有运行中的任务，直接输入即可。\n");
      } else {
        void session.sendInput(text, undefined, { steer: true }).catch(
          (error) => {
            output.write(
              `\nSteer 失败：${error instanceof Error ? error.message : "未知错误"}\n`,
            );
          },
        );
        output.write("已插队：当前工具完成后将转向新指令。\n");
      }
      safePrompt();
      return;
    }
    if (line === "/cost") {
      const summary = session.summary();
      const cacheRate =
        summary.totalInputTokens > 0
          ? Math.round(
              (summary.totalCachedTokens / summary.totalInputTokens) * 100,
            )
          : 0;
      output.write(
        `累计 ${summary.totalInputTokens} input / ` +
          `${summary.totalOutputTokens} output / ` +
          `${summary.totalCachedTokens} cached tokens（命中率 ${cacheRate}%）。\n`,
      );
      if (summary.totalMissedTokens > 0) {
        output.write(
          `累计缓存浪费 ${summary.totalMissedTokens} tokens` +
            `${
              summary.totalMissedCostCny > 0
                ? `（多花 ¥${summary.totalMissedCostCny.toFixed(4)}）`
                : ""
            }；压缩导致的重置不计入。\n`,
        );
      }
      if (summary.totalCostCny > 0) {
        output.write(
          `按已配置模型单价估算：¥${summary.totalCostCny.toFixed(4)}。\n`,
        );
      }
      safePrompt();
      return;
    }
    if (line === "/sessions") {
      for (const summary of manager.list()) {
        output.write(
          `${summary.id === session.id ? "→" : " "} #${summary.id} · ` +
            `${summary.title} · ${summary.status} · ` +
            `${summary.permissionMode} 档 · ` +
            `${summary.totalInputTokens + summary.totalOutputTokens} tokens\n`,
        );
      }
      safePrompt();
      return;
    }
    if (line === "/resume" || line.startsWith("/resume ")) {
      const rest = line.slice("/resume".length).trim();
      if (!rest) {
        // 无参数：续跑当前会话崩溃中断的任务
        const interrupted = session.interruptedTask();
        if (!interrupted) {
          output.write("当前会话没有中断的任务可续跑。\n");
        } else if (session.isProcessing()) {
          output.write("当前会话已有任务在运行。\n");
        } else {
          output.write(
            `正在续跑中断任务 #${interrupted.taskId}：${interrupted.description}\n`,
          );
          void session.resumeTask().catch((error) => {
            output.write(
              `\n续跑失败：${error instanceof Error ? error.message : "未知错误"}\n`,
            );
            safePrompt(true);
          });
        }
        safePrompt();
        return;
      }
      // 带参数：切换会话（兼容旧语义 /resume <id>）
      const target = manager.get(rest);
      if (!target) {
        output.write(`未找到会话 #${rest}。\n`);
      } else {
        unsubscribe();
        session = target;
        approvalState.pendingCallId = "";
        unsubscribe = subscribeToSession(session);
        const summary = session.summary();
        output.write(
          `已切换到 #${summary.id} · ${summary.title} · ${summary.status}\n`,
        );
      }
      safePrompt();
      return;
    }
    if (line.startsWith("/switch ")) {
      const id = line.slice("/switch ".length).trim();
      const target = manager.get(id);
      if (!target) {
        output.write(`未找到会话 #${id}。\n`);
      } else {
        unsubscribe();
        session = target;
        approvalState.pendingCallId = "";
        unsubscribe = subscribeToSession(session);
        const summary = session.summary();
        output.write(
          `已切换到 #${summary.id} · ${summary.title} · ${summary.status}\n`,
        );
      }
      safePrompt();
      return;
    }
    if (line === "/compact") {
      try {
        const compacted = await session.compact();
        output.write(
          compacted
            ? "上下文压缩完成。\n"
            : "当前历史不足以压缩，至少需要超过保留轮数。\n",
        );
      } catch (error) {
        output.write(
          `${error instanceof Error ? error.message : "上下文压缩失败"}\n`,
        );
      }
      safePrompt();
      return;
    }
    if (line === "/tree") {
      const branches = session.branches();
      const current = session.currentBranchId();
      const byParent = new Map<string | null, SessionBranch[]>();
      for (const branch of branches) {
        const siblings = byParent.get(branch.parent) ?? [];
        siblings.push(branch);
        byParent.set(branch.parent, siblings);
      }
      const renderBranch = (
        parentId: string | null,
        prefix: string,
      ): void => {
        const siblings = (byParent.get(parentId) ?? []).sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
        siblings.forEach((branch, index) => {
          const isLast = index === siblings.length - 1;
          const isCurrent = branch.id === current;
          const label = branch.label ? ` ${branch.label}` : "";
          const forkInfo =
            branch.forkSeq !== null ? ` · fork@#${branch.forkSeq}` : "";
          output.write(
            `${prefix}${isLast ? "└─ " : "├─ "}#${branch.id}` +
              `${isCurrent ? " ⚡" : ""}${label}${forkInfo}\n`,
          );
          renderBranch(
            branch.id,
            `${prefix}${isLast ? "   " : "│  "}`,
          );
        });
      };
      output.write("分支树（⚡=当前分支）：\n");
      renderBranch(null, "");
      safePrompt();
      return;
    }
    if (line.startsWith("/branch ")) {
      const rest = line.slice("/branch ".length).trim();
      const match = rest.match(/^(\d+)(?:\s+(\S.*))?$/);
      if (!match) {
        output.write("用法：/branch <seq> [label] —— 从指定事件 seq 分裂新分支\n");
      } else {
        try {
          const forkSeq = Number(match[1]);
          const label = match[2];
          const branchId = session.forkBranch(forkSeq, label);
          output.write(
            `已从事件 #${forkSeq} 分裂出分支 #${branchId}` +
              "，后续输入将写入新分支（/tree 查看）。\n",
          );
        } catch (error) {
          output.write(
            `${error instanceof Error ? error.message : "分支失败"}\n`,
          );
        }
      }
      safePrompt();
      return;
    }
    if (line.startsWith("/goto ")) {
      const branchId = line.slice("/goto ".length).trim();
      try {
        session.switchBranch(branchId);
        output.write(
          `已切换到分支 #${branchId}，后续输入将写入该分支。\n`,
        );
      } catch (error) {
        output.write(
          `${error instanceof Error ? error.message : "切换分支失败"}\n`,
        );
      }
      safePrompt();
      return;
    }
    if (line === "/timeline") {
      for (const record of session.events().slice(-30)) {
        output.write(
          `#${record.seq} ${record.ts.slice(11, 19)} ${summarizeEvent(record.event)}\n`,
        );
      }
      safePrompt();
      return;
    }
    if (line === "/labels") {
      const bookmarks = session.bookmarks();
      if (bookmarks.length === 0) {
        output.write("暂无书签（/label <seq> <名称> 添加）。\n");
      } else {
        for (const bookmark of bookmarks) {
          output.write(`#${bookmark.seq} ${bookmark.name}\n`);
        }
      }
      safePrompt();
      return;
    }
    if (line.startsWith("/label ")) {
      const rest = line.slice("/label ".length).trim();
      const match = rest.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        output.write("用法：/label <seq> <名称>\n");
      } else {
        try {
          session.addBookmark(Number(match[1]), match[2]!);
          output.write(`已标记书签 #${match[1]}「${match[2]}」。\n`);
        } catch (error) {
          output.write(
            `${error instanceof Error ? error.message : "标记失败"}\n`,
          );
        }
      }
      safePrompt();
      return;
    }
    if (line.startsWith("/unlabel ")) {
      const seq = Number(line.slice("/unlabel ".length).trim());
      if (!Number.isInteger(seq) || seq <= 0) {
        output.write("用法：/unlabel <seq>\n");
      } else {
        session.removeBookmark(seq);
        output.write(`已移除 #${seq} 的书签。\n`);
      }
      safePrompt();
      return;
    }
    if (line === "/init") {
      void session.initializeProject().catch((error) => {
        output.write(
          `\n/init 启动失败：${error instanceof Error ? error.message : "未知错误"}\n`,
        );
        safePrompt(true);
      });
      safePrompt();
      return;
    }
    if (line === "/review") {
      // 任务验收链手动触发：对最近一次完成运行独立审查
      await session.reviewNow().catch((error) => {
        output.write(
          `\n/review 失败：${error instanceof Error ? error.message : "未知错误"}\n`,
        );
      });
      safePrompt();
      return;
    }
    if (line === "/config" || line.startsWith("/config ")) {
      await handleConfigCommand(line);
      safePrompt();
      return;
    }
    if (line === "/model" || line.startsWith("/model ")) {
      const rest =
        line === "/model" ? "" : line.slice("/model ".length).trim();
      if (!rest) {
        const config = await configService.readEffective();
        const roles = (["main", "cheap", "explore"] as ModelRole[])
          .map(
            (role) =>
              `${role}=${config.models[role].providerId}/${config.models[role].model}`,
          )
          .join(" · ");
        output.write(`角色模型：${roles}\n`);
        output.write(
          "用法：/model main <providerId>/<model> 切换模型（写入项目配置，热生效）\n",
        );
      } else {
        const match = rest.match(/^(main|cheap|explore)\s+(\S+)\/(.+)$/);
        if (!match) {
          output.write("用法：/model main <providerId>/<model>\n");
        } else {
          try {
            const role = match[1] as ModelRole;
            const providerId = match[2]!;
            const model = match[3]!;
            const config = await configService.read("project");
            const provider = config.providers.find(
              (candidate) => candidate.id === providerId,
            );
            if (!provider) {
              output.write(`供应商 ${providerId} 未配置（/config 查看）。\n`);
            } else {
              config.models[role].providerId = providerId;
              config.models[role].model = model;
              await configService.write("project", config);
              output.write(
                `已切换 ${role} → ${providerId}/${model}（配置热生效）\n`,
              );
            }
          } catch (error) {
            output.write(
              `${error instanceof Error ? error.message : "切换模型失败"}\n`,
            );
          }
        }
      }
      safePrompt();
      return;
    }
    if (line === "/trust") {
      try {
        const config = await configService.read("global");
        const list = Array.isArray(config.trustedProjects)
          ? config.trustedProjects
          : [];
        const resolved = path.resolve(cwd);
        if (list.includes(resolved)) {
          output.write(`当前目录已在信任项目列表：${resolved}\n`);
        } else {
          list.push(resolved);
          await configService.write("global", {
            ...config,
            trustedProjects: list,
          });
          output.write(`已将当前目录标记为信任项目：${resolved}\n`);
          output.write("可在 Web 设置页「信任项目」中移除。\n");
        }
      } catch (error) {
        output.write(
          `${error instanceof Error ? error.message : "标记信任项目失败"}\n`,
        );
      }
      safePrompt();
      return;
    }
    if (line.startsWith("/allow") || line.startsWith("/deny")) {
      if (!approvalState.pendingCallId) {
        output.write("当前没有待处理审批。\n");
      } else {
        session.resolvePermission(
          approvalState.pendingCallId,
          parseApprovalAnswer(line),
        );
        approvalState.pendingCallId = "";
      }
      safePrompt();
      return;
    }
    output.write(`未知命令：${line}。输入 /help 查看可用命令。\n`);
    safePrompt();
  }

  async function handleConfigCommand(line: string): Promise<void> {
    const rest = line === "/config" ? "" : line.slice("/config ".length).trim();
    try {
      if (!rest) {
        output.write(
          formatEffectiveConfig(await configService.readEffective()),
        );
        return;
      }
      if (rest === "global" || rest === "project") {
        output.write(
          JSON.stringify(
            await configService.readPublic(rest as ConfigScope),
            null,
            2,
          ) + "\n",
        );
        return;
      }
      if (rest.startsWith("set ")) {
        const { keyPath, value, scope } = parseConfigSetLine(
          rest.slice("set ".length).trim(),
        );
        const config = await configService.read(scope);
        // 顶层键存在性守卫（防手误键被静默创建写脏配置）；嵌套路径自动创建
        if (!(keyPath.split(".")[0]! in config)) {
          throw new Error(`配置项 ${keyPath} 不存在`);
        }
        const next = setConfigValue(
          config,
          keyPath,
          coerceConfigValue(getConfigValue(config, keyPath), value),
        );
        await configService.write(scope, next);
        output.write(`已更新 ${scope} 作用域配置项 ${keyPath}。\n`);
        return;
      }
      output.write(
        "用法：/config 摘要 | /config global|project 查看 | /config set <key> <value> [global|project]\n",
      );
    } catch (error) {
      output.write(`${error instanceof Error ? error.message : "配置操作失败"}\n`);
    }
  }

  function startRun(task: RunTaskOptions): void {
    void session.runTask(task).catch((error) => {
      output.write(
        `\n/run 启动失败：${error instanceof Error ? error.message : "未知错误"}\n`,
      );
      safePrompt(true);
    });
  }

  async function closeCli(): Promise<void> {
    if (closed) return;
    closed = true;
    session.interrupt();
    await manager.flush();
    // 释放单实例写锁（正常退出路径；崩溃残留时由下次启动的锁检测兜底）
    await manager.releaseLock();
    unsubscribe();
    input.off("keypress", onKeypress);
    if (input.isTTY) input.setRawMode(false);
    readline.close();
  }

  // SIGTERM（kill/守护进程停止路径）：走正常关闭链，flush 尾部事件后再退出
  process.on("SIGTERM", () => {
    void closeCli().then(() => process.exit(0));
  });

  const renderEvent = createEventRenderer({
    output: (text) => output.write(text),
    approvalState,
    showCacheMissNotices,
  });
  function subscribeToSession(target: AgentSession): () => void {
    return target.subscribe((record) => {
      renderEvent(record.event);
      // 0 工具调用完成提示：模型未调用任何工具就宣布完成（问答场景无碍，
      // 编码/搭建任务时提醒用户检查产出——Web 端任务清单有同义警告条）
      if (record.event.type === "done") {
        const events = target.events();
        const toolCalls = events.filter(
          (item) => item.event.type === "tool_call",
        ).length;
        if (toolCalls === 0) {
          output.write(
            "\n⚠ Agent 未调用任何工具就宣布完成——若这是编码/搭建任务，结果可能不完整，请检查产出或让 Agent 重新执行。\n",
          );
        } else {
          // 交付摘要（一行）：改动文件数 + 最后验证结果（与 Web 端同源，零成本）
          const files = new Set<string>();
          let verification: string | undefined;
          for (const item of events) {
            const event = item.event;
            if (
              event.type === "tool_call" &&
              (event.call.tool === "Write" ||
                event.call.tool === "Edit" ||
                event.call.tool === "MultiEdit")
            ) {
              if (event.call.target) files.add(event.call.target);
            }
            if (
              event.type === "tool_result" &&
              typeof event.summary === "string"
            ) {
              verification = event.summary;
            }
          }
          if (files.size > 0 || verification) {
            const verificationText = verification
              ? ` · 验证：${verification.slice(0, 48)}${verification.length > 48 ? "…" : ""}`
              : "";
            output.write(
              `\n✓ 完成 · 改动 ${files.size} 个文件${verificationText}\n`,
            );
          }
        }
      }
      if (!closed) safePrompt(true);
    });
  }
}
