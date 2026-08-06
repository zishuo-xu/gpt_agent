#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
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
import {
  toPublicConfig,
  type ModelRole,
} from "./config/schema.js";
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
} from "./cli-utils.js";
import {
  parseRunCommand,
  type RunTaskOptions,
} from "./core/run-task.js";
import type {
  AgentEvent,
  ApprovalAnswer,
  PermissionMode,
  SessionBranch,
} from "./core/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg: { version: string } = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
);
const VERSION: string = pkg.version;

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

if (process.argv.includes("--web")) {
  const { startWebServer } = await import("./web/server.js");
  await startWebServer({ cwd: process.cwd() });
} else {
  await runCli();
}

async function runCli(): Promise<void> {
  const cwd = process.cwd();
  const configService = new ConfigService({ cwd });
  // 缓存 miss 提示开关（behavior.showCacheMissNotices，热生效；默认关闭）
  let showCacheMissNotices = false;
  const initialConfig = await configService.readEffective();
  showCacheMissNotices =
    initialConfig.behavior?.showCacheMissNotices === true;
  configService.onChange((config) => {
    showCacheMissNotices = config.behavior?.showCacheMissNotices === true;
  });
  const manager = new AgentSessionManager({
    cwd,
    configService,
  });
  await manager.restore();
  let session = await manager.createSession({
    title: "CLI 会话",
    mode: "normal",
  });
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
          "/compact                           立即压缩当前会话上下文",
          "/tree                              查看会话分支树",
          "/branch <seq> [label]              从指定事件 seq 分裂新分支",
          "/goto <branchId>                    回溯切换到已有分支",
          "/timeline                          列出最近事件（查看分支点 seq）",
          "/init                              只读扫描并生成 AGENTS.md 草稿",
          "/config [global|project]           查看生效配置摘要或指定作用域配置",
          "/config set <key> <value> [global|project] 修改配置项",
          "/model                             查看角色模型；/model main <provider>/<model> 切换（热生效）",
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
    if (line.startsWith("/switch ") || line.startsWith("/resume ")) {
      const id = line.slice(line.indexOf(" ") + 1).trim();
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
    unsubscribe();
    input.off("keypress", onKeypress);
    if (input.isTTY) input.setRawMode(false);
    readline.close();
  }

  const renderEvent = createEventRenderer({
    output: (text) => output.write(text),
    approvalState,
    showCacheMissNotices,
  });
  function subscribeToSession(target: AgentSession): () => void {
    return target.subscribe((record) => {
      renderEvent(record.event);
      if (!closed) safePrompt(true);
    });
  }
}
