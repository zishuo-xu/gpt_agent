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
  toPublicConfig,
  type ModelRole,
  type MyAgentConfig,
} from "./config/schema.js";
import { AgentSessionManager } from "./core/session-manager.js";
import { AgentSession } from "./core/session.js";
import {
  parseRunCommand,
  type RunTaskOptions,
} from "./core/run-task.js";
import type {
  AgentEvent,
  ApprovalAnswer,
  PermissionMode,
  PermissionRule,
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
  let pendingApprovalCallId = "";
  let pendingRun: RunTaskOptions | undefined;
  let closed = false;

  let unsubscribe = subscribeToSession(session);

  readline.on("line", (raw) => {
    const line = raw.trim();
    if (!line) {
      readline.prompt();
      return;
    }
    if (pendingApprovalCallId && isApprovalAnswer(line)) {
      const answer = parseApprovalAnswer(line);
      const resolved = session.resolvePermission(
        pendingApprovalCallId,
        answer,
      );
      if (resolved) pendingApprovalCallId = "";
      readline.prompt();
      return;
    }
    if (pendingRun && ["y", "yes", "n", "no"].includes(line.toLowerCase())) {
      const confirmed = ["y", "yes"].includes(line.toLowerCase());
      const task = pendingRun;
      pendingRun = undefined;
      if (confirmed) startRun(task);
      else output.write("已取消无人值守任务。\n");
      readline.prompt();
      return;
    }
    if (line.startsWith("/")) {
      void handleCommand(line);
      return;
    }
    void session.sendInput(line).catch((error) => {
      output.write(
        `\n任务启动失败：${error instanceof Error ? error.message : "未知错误"}\n`,
      );
      readline.prompt(true);
    });
    readline.prompt();
  });

  readline.on("SIGINT", () => {
    if (session.interrupt()) {
      output.write("\n正在中止模型与当前工具…\n");
      readline.prompt(true);
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
      readline.prompt(true);
    }
  };
  input.on("keypress", onKeypress);

  output.write(
    `\n◆ MyAgent v0.1 · 会话 #${session.id}\n` +
      `  ${cwd} · ${session.summary().permissionMode} 档\n` +
      "  直接输入任务；运行中继续输入会排队；Esc 硬中止。\n" +
      "  输入 /help 查看命令。\n\n",
  );
  readline.prompt();

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
      readline.prompt();
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
      readline.prompt();
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
      readline.prompt();
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
      readline.prompt();
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
      readline.prompt();
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
        pendingApprovalCallId = "";
        unsubscribe = subscribeToSession(session);
        const summary = session.summary();
        output.write(
          `已切换到 #${summary.id} · ${summary.title} · ${summary.status}\n`,
        );
      }
      readline.prompt();
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
      readline.prompt();
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
      readline.prompt();
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
      readline.prompt();
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
      readline.prompt();
      return;
    }
    if (line === "/timeline") {
      for (const record of session.events().slice(-30)) {
        output.write(
          `#${record.seq} ${record.ts.slice(11, 19)} ${summarizeEvent(record.event)}\n`,
        );
      }
      readline.prompt();
      return;
    }
    if (line === "/init") {
      void session.initializeProject().catch((error) => {
        output.write(
          `\n/init 启动失败：${error instanceof Error ? error.message : "未知错误"}\n`,
        );
        readline.prompt(true);
      });
      readline.prompt();
      return;
    }
    if (line === "/config" || line.startsWith("/config ")) {
      await handleConfigCommand(line);
      readline.prompt();
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
      readline.prompt();
      return;
    }
    if (line.startsWith("/allow") || line.startsWith("/deny")) {
      if (!pendingApprovalCallId) {
        output.write("当前没有待处理审批。\n");
      } else {
        session.resolvePermission(
          pendingApprovalCallId,
          parseApprovalAnswer(line),
        );
        pendingApprovalCallId = "";
      }
      readline.prompt();
      return;
    }
    output.write(`未知命令：${line}。输入 /help 查看可用命令。\n`);
    readline.prompt();
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
        const body = rest.slice("set ".length).trim();
        const spaceIndex = body.indexOf(" ");
        if (spaceIndex < 0) {
          output.write("用法：/config set <key> <value> [global|project]\n");
          return;
        }
        const keyPath = body.slice(0, spaceIndex);
        let value = body.slice(spaceIndex + 1).trim();
        let scope: ConfigScope = "project";
        const lastToken = value.split(/\s+/).at(-1) ?? "";
        if (
          (lastToken === "global" || lastToken === "project") &&
          value.length > lastToken.length
        ) {
          scope = lastToken;
          value = value.slice(0, value.length - lastToken.length).trimEnd();
        }
        const config = await configService.read(scope);
        setConfigValue(config, keyPath, value);
        await configService.write(scope, config);
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
      readline.prompt(true);
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

  function renderEvent(event: AgentEvent): void {
    if (event.type === "user_queued") {
      output.write(`\n↳ 已排队：${event.text}\n`);
    }
    if (event.type === "text_delta") {
      output.write(`\n${event.text}\n`);
    }
    if (event.type === "todo_update") {
      output.write("\n任务清单：\n");
      for (const todo of event.todos) {
        const marker =
          todo.status === "completed"
            ? "✓"
            : todo.status === "in_progress"
              ? "→"
              : "○";
        output.write(`  ${marker} ${todo.content}\n`);
      }
    }
    if (event.type === "tool_call") {
      output.write(`\n→ ${event.call.tool}(${event.call.target})\n`);
    }
    if (event.type === "ask_permission") {
      pendingApprovalCallId = event.call.id;
      output.write(
        `  需要审批：${event.risk}\n` +
          `  ${event.call.tool}(${event.call.target})\n` +
          `${event.detail ? `${event.detail}\n` : ""}` +
          "  输入 y/n；/allow session|project|global 可记住；/deny 可附留言。\n",
      );
    }
    if (event.type === "permission_denied") {
      if (pendingApprovalCallId === event.call.id) {
        pendingApprovalCallId = "";
      }
      output.write(`\n拒绝：${event.reason}\n`);
    }
    if (event.type === "tool_result") {
      output.write(`  ${event.summary}\n`);
    }
    if (event.type === "cost_update") {
      const missedLabel =
        !event.missedTokens || event.missedTokens <= 0
          ? ""
          : event.missedReason === "compaction"
            ? " · 缓存已重置（压缩）"
            : event.missedReason === "model_switch"
              ? ` · 缓存失效 ${event.missedTokens}（模型切换）`
              : event.missedReason === "idle"
                ? ` · 缓存过期 ${event.missedTokens}（空闲超时）`
                : ` · 缓存未命中浪费 ${event.missedTokens}`;
      const missedCostLabel =
        event.missedCostCny && event.missedCostCny > 0
          ? `（多花 ¥${event.missedCostCny.toFixed(4)}）`
          : "";
      output.write(
        `  本轮 ${event.input} in / ${event.output} out` +
          `${event.cached ? ` / ${event.cached} cached` : ""}` +
          ` · 会话累计 ${event.totalTokens}` +
          missedLabel +
          missedCostLabel +
          "\n",
      );
    }
    if (event.type === "context_compacted") {
      output.write(
        `\n上下文已压缩：保留比例 ${(event.ratio * 100).toFixed(1)}%\n`,
      );
    }
    if (event.type === "task_start") {
      output.write(`\n◇ 子代理：${event.description}\n`);
    }
    if (event.type === "task_end") {
      output.write(
        `  子代理 ${event.status} · ${event.toolCalls} 次工具调用 · ` +
          `${event.inputTokens} in / ${event.outputTokens} out\n`,
      );
    }
    if (event.type === "run_started") {
      output.write(
        `\n◆ 无人值守任务 #${event.taskId} 已启动 · ${event.permissionMode} 档\n`,
      );
    }
    if (event.type === "wrapup_warning") {
      output.write(`\n⚠ 任务进入 ${event.level} 阶段：${event.message}\n`);
    }
    if (event.type === "run_finished") {
      output.write(
        `\n◆ 无人值守任务 #${event.taskId} ${event.status}` +
          `${event.reason ? `（${event.reason}）` : ""}，权限档已回落。\n`,
      );
    }
    if (event.type === "model_fallback") {
      output.write(
        `\n↪ ${event.role} 模型降级：${event.from} → ${event.to}\n` +
          `  原因：${event.reason}\n`,
      );
    }
    if (event.type === "need_user") {
      output.write(`\n需要你的决定：${event.question}\n`);
    }
    if (event.type === "done") {
      output.write("\n✓ 本轮任务完成，可继续输入。\n");
    }
    if (event.type === "error") {
      output.write(`\n运行失败：${event.message}\n`);
    }
    if (event.type === "notify") {
      const icon = event.level === "warn" ? "⚠" : event.level === "error" ? "✗" : "ℹ";
      output.write(`\n${icon} ${event.message}\n`);
    }
    if (event.type === "interrupted") {
      output.write(
        "\n任务已中止；文件编辑保持原子性，Bash 已发生的副作用无法自动撤销。\n",
      );
    }
    if (event.type === "branch_switch") {
      output.write(
        `\n⇄ 已切换到分支 #${event.branchId}` +
          `${event.label ? `（${event.label}）` : ""}\n`,
      );
    }
  }

  function subscribeToSession(target: AgentSession): () => void {
    return target.subscribe((record) => {
      renderEvent(record.event);
      if (!closed) readline.prompt(true);
    });
  }
}

function formatEffectiveConfig(config: MyAgentConfig): string {
  const counts: Record<PermissionRule["effect"], number> = {
    allow: 0,
    ask: 0,
    deny: 0,
  };
  for (const rule of config.permissions.rules) counts[rule.effect]++;
  const modelRoles = (["main", "cheap", "explore"] as ModelRole[])
    .map(
      (role) =>
        `${role}=${config.models[role].providerId}/${config.models[role].model}`,
    )
    .join(" · ");
  return (
    [
      `权限档：${config.permissions.mode} · 审批超时 ${config.permissions.approvalTimeoutMs}ms`,
      `权限规则：allow ${counts.allow} / ask ${counts.ask} / deny ${counts.deny}`,
      `角色模型：${modelRoles}`,
      `上下文：压缩阈值 ${config.context.compactAtEstimatedTokens} tokens · 保留 ${config.context.keepRecentTurns} 轮`,
      `Web：host ${config.server.host}${config.server.password ? " · 已设访问密码" : ""}`,
    ].join("\n") + "\n"
  );
}

function setConfigValue(
  config: MyAgentConfig,
  keyPath: string,
  rawValue: string,
): void {
  const segments = keyPath.split(".");
  if (segments.length < 1) throw new Error("配置键不能为空");
  let target: Record<string, unknown> =
    config as unknown as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = target[segment];
    if (!next || typeof next !== "object") {
      throw new Error(`配置项 ${keyPath} 不存在`);
    }
    target = next as Record<string, unknown>;
  }
  const leaf = segments.at(-1)!;
  const current = target[leaf];
  if (typeof current === "number") {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) throw new Error(`配置项 ${keyPath} 需要数字`);
    target[leaf] = value;
  } else if (typeof current === "boolean") {
    const normalized = rawValue.toLowerCase();
    if (!["true", "false"].includes(normalized)) {
      throw new Error(`配置项 ${keyPath} 需要 true/false`);
    }
    target[leaf] = normalized === "true";
  } else {
    target[leaf] = rawValue;
  }
}

/** 事件时间线摘要：为 /timeline 提供单行描述（选择 fork 点用） */
function summarizeEvent(event: AgentEvent): string {
  switch (event.type) {
    case "user":
      return `用户：${event.text.slice(0, 40)}`;
    case "text_delta":
      return `助手：${event.text.slice(0, 40)}`;
    case "tool_call":
      return `工具：${event.call.tool}(${event.call.target})`;
    case "tool_result":
      return `结果：${event.summary.slice(0, 40)}`;
    case "permission_denied":
      return `拒绝：${event.reason.slice(0, 40)}`;
    case "branch_switch":
      return `分支切换：→ #${event.branchId}`;
    case "context_compacted":
      return `上下文压缩：${event.summary.slice(0, 40)}`;
    case "run_started":
      return `无人值守任务：${event.description.slice(0, 40)}`;
    default:
      return event.type;
  }
}

function isApprovalAnswer(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    ["y", "yes", "n", "no"].includes(normalized) ||
    normalized === "/allow" ||
    normalized.startsWith("/allow ") ||
    normalized === "/deny" ||
    normalized.startsWith("/deny ")
  );
}

function parseApprovalAnswer(value: string): ApprovalAnswer {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();
  if (lower === "y" || lower === "yes" || lower === "/allow") {
    return { granted: true, scope: "once" };
  }
  if (lower.startsWith("/allow ")) {
    const requested = lower.slice("/allow ".length).trim();
    const scope: NonNullable<ApprovalAnswer["scope"]> = [
      "once",
      "session",
      "project",
      "global",
    ].includes(requested)
      ? (requested as NonNullable<ApprovalAnswer["scope"]>)
      : "once";
    return { granted: true, scope };
  }
  const feedback = lower.startsWith("/deny ")
    ? normalized.slice("/deny ".length).trim()
    : "";
  return {
    granted: false,
    ...(feedback ? { feedback } : {}),
  };
}
